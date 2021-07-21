import { CodeBlockWriter, SourceFile, WriterFunction, WriterFunctionOrValue, Writers } from 'ts-morph'
import { OpenAPIV3 } from 'openapi-types'

type WriterFunctionOrString = string | WriterFunction

export async function generateTypes (
  file: SourceFile,
  spec: OpenAPIV3.Document,
  opts: { addReadonlyWriteonlyModifiers: boolean }
): Promise<void> {
  if (opts.addReadonlyWriteonlyModifiers === true) {
    // Idea from https://stackoverflow.com/a/52443757
    file.addTypeAlias({
      name: 'readonlyP',
      type: "{ readonly?: '__readonly' }"
    })
    file.addTypeAlias({
      name: 'writeonlyP',
      type: "{ writeonly?: '__writeonly' }"
    })

    file.addTypeAlias({
      name: 'Primitive',
      type: 'string | Function | number | boolean | Symbol | undefined | null | Date'
    })
    for (const modifier of ['Readonly', 'Writeonly']) {
      file.addTypeAlias({
        name: `PropsWithout${modifier}`,
        typeParameters: ['T'],
        type: (writer) => {
          writer.write('{')
          writer.withIndentationLevel(1, () => writer.writeLine(`[key in keyof T]: T[key] extends ${modifier.toLowerCase()}P ? never : key`))
          writer.write('}[keyof T]')
        }
      })
      file.addTypeAlias({
        name: `Without${modifier}`,
        typeParameters: ['T'],
        isExported: true,
        type: (writer) => {
          writer.write('T extends any ?')
          writer.withIndentationLevel(1, () => writer.writeLine(`T extends ${modifier.toLowerCase()}P ? never :`))
          writer.withIndentationLevel(1, () => writer.writeLine('T extends Primitive ? T :'))
          writer.withIndentationLevel(1, () => writer.writeLine(`T extends Array<infer U> ? Without${modifier}<U>[] :`))
          writer.withIndentationLevel(1, () => writer.writeLine('{'))
          writer.withIndentationLevel(2, () => writer.writeLine(`[key in PropsWithout${modifier}<T>]: T[key] extends any ? WithoutWriteonly<T[key]> : never`))
          writer.withIndentationLevel(1, () => writer.writeLine('}'))
          writer.write(': never')
        }
      })
    }
  }

  for (const [name, schema] of Object.entries(spec.components?.schemas ?? {})) {
    if ('enum' in schema && schema.enum) {
      if (typeof schema.enum[0] === 'number') {
        file.addTypeAlias({
          isExported: true,
          name,
          type: schema.enum.length > 1 ?
            Writers.unionType(...(schema.enum.map(m => String(m)) as [string, string, ...string[]])) :
            String(schema.enum[0])
        })
      } else {
        file.addEnum({
          isExported: true,
          name,
          members: schema.enum.map((val) => ({ name: val.toUpperCase(), value: val }))
        })
      }
      continue
    }
    file.addTypeAlias({
      isExported: true,
      name: stringifyName(name),
      type: generateTypeForSchema(schema, spec)
    })
  }
}

export function generateTypeForSchema (
  schema: OpenAPIV3.ReferenceObject | OpenAPIV3.ArraySchemaObject | OpenAPIV3.NonArraySchemaObject,
  spec: OpenAPIV3.Document,
  prefixRef?: string,
  addReadonlyWriteonlyPrefix?: boolean,
  opts: { readonly: boolean, writeonly: boolean, addReaonlyAndWriteonlyFilters: boolean } = {
    readonly: true,
    writeonly: true,
    addReaonlyAndWriteonlyFilters: true
  }
): WriterFunctionOrString {
  // Note: we use another to function to avoid needing to pass every arguments for recursive calls
  function generate (
    schema: OpenAPIV3.ReferenceObject | OpenAPIV3.ArraySchemaObject | OpenAPIV3.NonArraySchemaObject
  ): WriterFunctionOrString {
    if ('$ref' in schema) {
      let ref = extractRef(schema.$ref)
      if (prefixRef) ref = `${prefixRef}${ref}`
      // we don't add prefixes with enums (Types.WithoutReadonly<EnumName> doesn't work)
      const schemaForRef = retrieveRef(schema.$ref, spec)
      const refIsEnum = Array.isArray(schemaForRef.enum)
      if (addReadonlyWriteonlyPrefix && refIsEnum === false) {
        const typeName = opts.readonly === true ? 'WithoutWriteonly' : 'WithoutReadonly'
        ref = `${prefixRef ?? ''}${typeName}<${ref}>`
      }
      return ref
    }
    if (schema.allOf) {
      const types: WriterFunctionOrString[] = schema.allOf.map((subschema) => {
        return generate(subschema)
      })
      if (types.length < 2) {
        return types[0]
      }
      return Writers.intersectionType(...(types as [WriterFunctionOrString, WriterFunctionOrString, ...WriterFunctionOrString[]]))
    }
    if (schema.oneOf) {
      const types = schema.oneOf.map((subschema) => {
        return generate(subschema)
      }) as [WriterFunctionOrString, WriterFunctionOrString, ...WriterFunctionOrString[]]
      return Writers.unionType(...types)
    }
    if (schema.type === 'array') {
      const writerOrValue = generate(schema.items)
      return (writer) => {
        writer.write('(')
        if (typeof writerOrValue === 'function') {
          writerOrValue(writer)
        } else {
          writer.write(writerOrValue)
        }
        writer.write(')[]')
      }
    }
    if (schema.type === 'object') {
      const props = Object.entries(schema.properties ?? {})
        .reduce((props, [name, prop]) => {
          const questionMark = schema.required?.includes(name) === true ? '' : '?'
          const isReadonly = 'readOnly' in prop && prop.readOnly
          const isWriteonly = 'writeOnly' in prop && prop.writeOnly
          if (opts.readonly === false && isReadonly) {
            return props
          }
          if (opts.writeonly === false && isWriteonly) {
            return props
          }
          props[`${isReadonly ? 'readonly ' : ''}'${name}'${questionMark}`] = (writer) => {
            if (opts.addReaonlyAndWriteonlyFilters && (isReadonly || isWriteonly)) {
              writer.write('(') // we need to surround with parenthesis for unions (e.g. (string | number) & readOnly)
            }
            writeWriterOrString(writer, generate(prop))
            if (opts.addReaonlyAndWriteonlyFilters && isReadonly) {
              writer.write(') & readonlyP') // Used to remove them with mapped types
            }
            if (opts.addReaonlyAndWriteonlyFilters && isWriteonly) {
              writer.write(') & writeonlyP') // Used to remove them with mapped types
            }
          }
          return props
        }, {} as Record<string, WriterFunctionOrValue>)
      if (schema.additionalProperties && typeof schema.additionalProperties !== 'boolean') {
        props[`[key: string]`] = generate(schema.additionalProperties)
      }
      return Writers.object(props)
    }
    if (schema.type === 'boolean') {
      if (schema.enum) {
        return schema.enum.join(' | ')
      }
      return nullable('boolean', schema.nullable)
    }
    if (schema.type === 'integer' || schema.type === 'number') {
      if (schema.enum) {
        return schema.enum.join(' | ')
      }
      return nullable('number', schema.nullable)
    }
    if (schema.format === 'date' || schema.format === 'date-time') {
      return nullable('Date', schema.nullable)
    }
    if (schema.type === 'string') {
      if (schema.enum) {
        return schema.enum.map(member => `'${member}'`).join(' | ')
      }
      return nullable('string', schema.nullable)
    }
    if (schema.type === 'null') {
      return 'null'
    }
    return nullable('any', schema.nullable)
  }
  return generate(schema)
}

function nullable (type: string, nullable: boolean = false) {
  if (nullable === false) {
    return type
  }
  return `${type} | null`
}

export function writeWriterOrString (
  writer: CodeBlockWriter,
  writerOrValue: WriterFunctionOrString
) {
  if (typeof writerOrValue === 'function') {
    writerOrValue(writer)
  } else {
    writer.write(writerOrValue)
  }
}

function extractRef (ref: string) {
  return stringifyName(ref.substr('#/components/schemas/'.length))
}

function retrieveRef (ref: string, spec: OpenAPIV3.Document): OpenAPIV3.SchemaObject {
  const schema = spec.components!.schemas![ref.substr('#/components/schemas/'.length)]
  if ('$ref' in schema) {
    return retrieveRef(schema.$ref, spec)
  }
  return schema
}

function stringifyName (name: string) {
  return name.replace(/\.|-/g, '_')
}
