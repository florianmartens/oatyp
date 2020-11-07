import { Scope, SourceFile, WriterFunctionOrValue, Writers } from 'ts-morph'
import { OpenAPIV3 } from 'openapi-types'
import { generateTypeForSchema, writeWriterOrString } from './types'

const METHODS_WITH_DATA = ['post', 'patch', 'put']

export async function generateApi (// TODO: Use Omit for readonly / writeonly props
  file: SourceFile,
  spec: OpenAPIV3.Document,
  opts: { removeTagFromOperationId: boolean }
): Promise<void> {
  // Imports
  file.addImportDeclaration({
    defaultImport: 'axios',
    namedImports: ['AxiosInstance', 'AxiosRequestConfig'],
    moduleSpecifier: 'axios'
  })
  file.addImportDeclaration({
    namespaceImport: 'Types',
    moduleSpecifier: './definitions'
  })

  // Utils
  file
    .addFunction({
      name: 'pick',
      parameters: [{ name: 'obj', type: 'T' }, { name: 'keys', type: 'K[]', isRestParameter: true }],
      typeParameters: [{ name: 'T' }, { name: 'K', constraint: 'keyof T' }]
    })
    .setReturnType('Pick<T, K>')
    .setBodyText('const ret: any = {};\nkeys.forEach(key => {\n    ret[key] = obj[key];\n})\nreturn ret;')

  // Init class
  const classDeclaration = file.addClass({
    isDefaultExport: true
  })
  const classDeclarationMethods = new Map<string, Record<string, WriterFunctionOrValue>>()

  // Constructor
  classDeclaration
    .addProperty({
      name: 'axios',
      scope: Scope.Private,
      type: 'AxiosInstance'
    })
  classDeclaration
    .addConstructor({
      parameters: [{
        name: 'config',
        type: 'AxiosRequestConfig'
      }]
    })
    .setBodyText((writer) => {
      writer.write('this.axios = axios.create(config)')
    })

  // Operations
  for (const [path, operations] of Object.entries(spec.paths)) {
    for (const method of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'] as const) {
      const operation = operations[method]
      const operationId = operation?.operationId // Must be defined
      if (operation === undefined || operationId === undefined) continue
      // We add the operation method for each tag
      // by default we fallback to `default` tag if not provided
      const tags = operation.tags ?? ['default']
      for (const tag of tags) {
        // Initialize object for tag
        if (classDeclarationMethods.has(tag) === false) {
          classDeclarationMethods.set(tag, {})
        }
        const tagObject = classDeclarationMethods.get(tag)!

        const responses = operation.responses
        if (typeof responses === 'undefined' || Object.keys(responses).length === 0) continue
        const [, successResponseObject] = Object.entries(responses)[0] as [string, OpenAPIV3.ResponseObject]
        const successResponse = successResponseObject.content!['application/json']

        // Handle operation method
        const methodName = camelize(operationId)
        const methodDeclaration = classDeclaration
          .addMethod({
            scope: Scope.Private,
            name: methodName
          })
        // Add parameters
        methodDeclaration.addParameter({
          name: 'params',
          type: Writers.object(
            (operation.parameters ?? []).reduce((params, param) => {
              const config = param as OpenAPIV3.ParameterObject
              params[`'${config.name}'`] = generateTypeForSchema(config.schema ?? {}, 'Types')
              return params
            }, {} as Record<string, WriterFunctionOrValue>)
          )
        })
        // Add body
        if (METHODS_WITH_DATA.includes(method)) {
          const bodySchema = (operation.requestBody as OpenAPIV3.RequestBodyObject | undefined)?.content['application/json'].schema
          if (bodySchema) {
            methodDeclaration.addParameter({
              name: 'data',
              type: generateTypeForSchema(bodySchema, 'Types')
            })
          }
        }
        // Add axios config options params
        methodDeclaration.addParameter({
          name: 'options',
          type: 'AxiosRequestConfig',
          hasQuestionToken: true
        })
        // Axios call
        methodDeclaration.setBodyText(Writers.returnStatement((writer) => {
          writer.write(`this.axios.${method}<`)
          // Return type
          writeWriterOrString(writer, generateTypeForSchema(successResponse.schema!, 'Types'))
          writer.write('>(')
          // Endpoint
          writer.quote(path)
          // We need to replace url parameters in the endpoint
          for (const param of operation.parameters ?? []) {
            const config = param as OpenAPIV3.ParameterObject
            if (config.in !== 'path') continue
            writer.write(`.replace(/{${config.name}}/, String(params[`)
            writer.quote(config.name)
            writer.write(']))')
          }
          // Data
          if (METHODS_WITH_DATA.includes(method)) {
            writer.write(', data')
          }
          // Axios config
          writer.write(', Object.assign({}, { headers: ' + generatePickString(operation, 'header') + ', params: ' + generatePickString(operation, 'query') + ' }, options)')
          // Data
          writer.write(')')
        }))

        // Add to getter
        let getterName = methodName
        if (opts.removeTagFromOperationId) {
          getterName = getterName.replace(new RegExp(tag, 'gi'), '')
        }
        tagObject[getterName] = `this.${methodName}.bind(this)`
      }
    }
  }

  // Add get accessors with objects
  for (const [tag, object] of classDeclarationMethods.entries()) {
    classDeclaration
      .addGetAccessor({ name: camelize(tag) })
      .setBodyText(
        Writers.returnStatement(Writers.object(object))
      )
  }
}

function camelize (str: string) {
  return str.replace(/\W+(.)/g, (match, chr) => chr.toUpperCase())
}

function generatePickString (operation: OpenAPIV3.OperationObject, paramsType: 'query' | 'header' | 'path') {
  const params = operation.parameters?.filter((param) => {
    return 'in' in param && param.in === paramsType
  }) as OpenAPIV3.ParameterObject[]
  if (params.length === 0) return '{}'
  return `pick(params, "${params.map(p => p.name).join('", "')}")`
}
