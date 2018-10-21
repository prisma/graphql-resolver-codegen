import * as os from 'os'
import * as capitalize from 'capitalize'
import * as prettier from 'prettier'
import * as ts from 'typescript'

import { GenerateArgs, ModelMap, ContextDefinition } from '../types'
import { GraphQLTypeField, GraphQLTypeObject } from '../source-helper'
import { findTypescriptInterfaceByName, getChildrenNodes } from '../ast'

type SpecificGraphQLScalarType = 'boolean' | 'number' | 'string'

interface InputTypesMap {
  [s: string]: GraphQLTypeObject
}

interface TypeToInputTypeAssociation {
  [s: string]: string[]
}

export function format(code: string, options: prettier.Options = {}) {
  try {
    return prettier.format(code, {
      ...options,
      parser: 'typescript',
    })
  } catch (e) {
    console.log(
      `There is a syntax error in generated code, unformatted code printed, error: ${JSON.stringify(
        e,
      )}`,
    )
    return code
  }
}

export function generate(args: GenerateArgs): string {
  // TODO: Maybe move this to source helper
  const inputTypesMap: InputTypesMap = args.types
    .filter(type => type.type.isInput)
    .reduce((inputTypes, type) => {
      return {
        ...inputTypes,
        [`${type.name}`]: type,
      }
    }, {})

  // TODO: Type this
  const typeToInputTypeAssociation: TypeToInputTypeAssociation = args.types
    .filter(
      type =>
        type.type.isObject &&
        type.fields.filter(
          field => field.arguments.filter(arg => arg.type.isInput).length > 0,
        ).length > 0,
    )
    .reduce((types, type) => {
      return {
        ...types,
        [`${type.name}`]: [].concat(
          ...(type.fields.map(field =>
            field.arguments
              .filter(arg => arg.type.isInput)
              .map(arg => arg.type.name),
          ) as any),
        ),
      }
    }, {})

  return `\
  ${renderHeader(args)}

  ${renderNamespaces(args, typeToInputTypeAssociation, inputTypesMap)}

  ${renderResolvers(args)}

  `
}

function renderHeader(args: GenerateArgs): string {
  const modelArray = Object.keys(args.modelMap).map(k => args.modelMap[k])
  const modelImports = modelArray
    .map(
      m =>
        `import { ${m.modelTypeName} } from '${m.importPathRelativeToOutput}'`,
    )
    .join(os.EOL)

  return `
// Code generated by github.com/prisma/graphqlgen, DO NOT EDIT.

import { GraphQLResolveInfo } from 'graphql'
${renderContext(args.context)}
${modelImports}
  `
}

function renderContext(context?: ContextDefinition) {
  if (context) {
    return `import { ${getContextName(context)} } from '${context.contextPath}'`
  }

  return `type ${getContextName(context)} = any`
}

function renderNamespaces(
  args: GenerateArgs,
  typeToInputTypeAssociation: TypeToInputTypeAssociation,
  inputTypesMap: InputTypesMap,
): string {
  return args.types
    .filter(type => type.type.isObject)
    .map(type =>
      renderNamespace(
        type,
        typeToInputTypeAssociation,
        inputTypesMap,
        args.modelMap,
        args.context,
      ),
    )
    .join(os.EOL)
}

function renderNamespace(
  type: GraphQLTypeObject,
  typeToInputTypeAssociation: TypeToInputTypeAssociation,
  inputTypesMap: InputTypesMap,
  modelMap: ModelMap,
  context?: ContextDefinition,
): string {
  return `\
    export namespace ${type.name}Resolvers {

    ${renderScalarResolvers(type, modelMap)}

    ${renderInputTypeInterfaces(
      typeToInputTypeAssociation,
      inputTypesMap,
      type,
    )}

    ${renderInputArgInterfaces(type, modelMap)}

    ${renderResolverFunctionInterfaces(type, modelMap, context)}

    ${renderResolverTypeInterface(type, modelMap, context)}

    ${/* TODO renderResolverClass(type, modelMap) */ ''}
  }
  `
}

function renderInputTypeInterfaces(
  typeToInputTypeAssociation: TypeToInputTypeAssociation,
  inputTypesMap: InputTypesMap,
  type: GraphQLTypeObject,
) {
  if (!typeToInputTypeAssociation[type.name]) {
    return ``
  }
  return typeToInputTypeAssociation[type.name]
    .map(typeAssociation => {
      return `export interface ${inputTypesMap[typeAssociation].name} {
      ${inputTypesMap[typeAssociation].fields.map(
        field => `${field.name}: ${getTypeFromGraphQLType(field.type.name)}`,
      )}
    }`
    })
    .join(os.EOL)
}

function renderScalarResolvers(
  type: GraphQLTypeObject,
  modelMap: ModelMap,
): string {
  const model = modelMap[type.name]

  if (model === undefined) {
    return `export const defaultResolvers = {}`
  }

  const filePath = model.absoluteFilePath
  const interfaceNode = findTypescriptInterfaceByName(
    filePath,
    model.modelTypeName,
  )

  if (!interfaceNode) {
    throw new Error(`No interface found for name ${model.modelTypeName}`)
  }

  // NOTE unfortunately using `.getChildren()` didn't work, so we had to use the `forEachChild` method
  const interfaceChildNodes = getChildrenNodes(interfaceNode)

  return `export const defaultResolvers = {
    ${interfaceChildNodes
      .filter(childNode => childNode.kind === ts.SyntaxKind.PropertySignature)
      .map(childNode => {
        const childNodeProperty = childNode as ts.PropertySignature
        const fieldName = (childNodeProperty.name as ts.Identifier).text
        const fieldOptional = !!childNodeProperty.questionToken
        return { fieldName, fieldOptional }
      })
      .filter(({ fieldName }) =>
        type.fields.some(field => field.name === fieldName),
      )
      .map(({ fieldName, fieldOptional }) =>
        renderScalarResolver(fieldName, fieldOptional, model.modelTypeName),
      )
      .join(os.EOL)}
  }`
}

function renderScalarResolver(
  fieldName: string,
  fieldOptional: boolean,
  parentTypeName: string,
): string {
  const field = `parent.${fieldName}`
  const fieldGetter = renderFieldGetter(field, fieldOptional)
  return `${fieldName}: (parent: ${parentTypeName}) => ${fieldGetter},`
}

function renderFieldGetter(
  fieldGetter: string,
  fieldOptional: boolean,
): string {
  if (fieldOptional) {
    return `${fieldGetter} === undefined ? null : ${fieldGetter}`
  }

  return fieldGetter
}

function renderInputArgInterfaces(
  type: GraphQLTypeObject,
  modelMap: ModelMap,
): string {
  return type.fields
    .map(field => renderInputArgInterface(field, modelMap))
    .join(os.EOL)
}

function renderInputArgInterface(
  field: GraphQLTypeField,
  modelMap: ModelMap,
): string {
  if (field.arguments.length === 0) {
    return ''
  }

  return `
  export interface Args${capitalize(field.name)} {
    ${field.arguments
      .map(
        arg =>
          `${arg.name}: ${printFieldLikeType(
            arg as GraphQLTypeField,
            modelMap,
          )}`,
      )
      .join(os.EOL)}
  }
  `
}

function renderResolverFunctionInterfaces(
  type: GraphQLTypeObject,
  modelMap: ModelMap,
  context?: ContextDefinition,
): string {
  return type.fields
    .map(field =>
      renderResolverFunctionInterface(field, type, modelMap, context),
    )
    .join(os.EOL)
}

function renderResolverFunctionInterface(
  field: GraphQLTypeField,
  type: GraphQLTypeObject,
  modelMap: ModelMap,
  context?: ContextDefinition,
): string {
  // TODO double check parent for union/enum
  //   parent: ${getModelName(type.name, modelMap)}${
  //   type.type.isEnum || type.type.isUnion ? '' : 'Parent'
  // },
  return `
  export type ${capitalize(field.name)}Resolver = (
    parent: ${getModelName(type.name, modelMap)},
    args: ${
      field.arguments.length > 0 ? `Args${capitalize(field.name)}` : '{}'
    },
    ctx: ${getContextName(context)},
    info: GraphQLResolveInfo,
  ) => ${printFieldLikeType(field, modelMap)} | Promise<${printFieldLikeType(
    field,
    modelMap,
  )}>
  `
}

function renderResolverTypeInterface(
  type: GraphQLTypeObject,
  modelMap: ModelMap,
  context?: ContextDefinition,
): string {
  return `
  export interface Type {
    ${type.fields
      .map(field =>
        renderResolverTypeInterfaceFunction(field, type, modelMap, context),
      )
      .join(os.EOL)}
  }
  `
}

function renderResolverTypeInterfaceFunction(
  field: GraphQLTypeField,
  type: GraphQLTypeObject,
  modelMap: ModelMap,
  context?: ContextDefinition,
): string {
  return `
    ${field.name}: (
      parent: ${getModelName(type.name, modelMap)},
      args: ${
        field.arguments.length > 0 ? `Args${capitalize(field.name)}` : '{}'
      },
      ctx: ${getContextName(context)},
      info: GraphQLResolveInfo,
    ) => ${printFieldLikeType(field, modelMap)} | Promise<${printFieldLikeType(
    field,
    modelMap,
  )}>
  `
}

function renderResolvers(args: GenerateArgs): string {
  return `
export interface Resolvers {
  ${args.types
    .filter(type => type.type.isObject)
    .map(type => `${type.name}: ${type.name}Resolvers.Type`)
    .join(os.EOL)}
}
  `
}

function getModelName(typeName: string, modelMap: ModelMap): string {
  const model = modelMap[typeName]

  // NOTE if no model is found, return the empty type
  // It's usually assumed that every GraphQL type has a model associated
  // expect for the `Query`, `Mutation` and `Subscription` type
  if (model === undefined) {
    return '{}'
  }

  return model.modelTypeName
}

function printFieldLikeType(field: GraphQLTypeField, modelMap: ModelMap) {
  if (field.type.isScalar) {
    return `${getTypeFromGraphQLType(field.type.name)}${
      field.type.isArray ? '[]' : ''
    }${!field.type.isRequired ? '| null' : ''}`
  }

  if (field.type.isInput) {
    return `${field.type.name}${field.type.isArray ? '[]' : ''}${
      !field.type.isRequired ? '| null' : ''
    }`
  }

  return `${getModelName(field.type.name, modelMap)}${
    field.type.isArray ? '[]' : ''
  }${!field.type.isRequired ? '| null' : ''}`
}

function getTypeFromGraphQLType(type: string): SpecificGraphQLScalarType {
  if (type === 'Int' || type === 'Float') {
    return 'number'
  }
  if (type === 'Boolean') {
    return 'boolean'
  }
  if (type === 'String' || type === 'ID' || type === 'DateTime') {
    return 'string'
  }
  return 'string'
}

function getContextName(context?: ContextDefinition) {
  if (!context) {
    return 'Context'
  }

  return context.interfaceName
}
