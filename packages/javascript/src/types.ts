import type { paths } from './schema.js';

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
export type ApiPath<M extends Method> = {
  [P in keyof paths]: Lowercase<M> extends keyof paths[P]
    ? NonNullable<paths[P][Lowercase<M>]> extends never ? never : P
    : never;
}[keyof paths];
type Operation<M extends Method, P extends ApiPath<M>> = Lowercase<M> extends keyof paths[P]
  ? NonNullable<paths[P][Lowercase<M>]>
  : never;

type Field<T, K extends PropertyKey> = K extends keyof T ? T[K] : never;
type Parameter<T, K extends PropertyKey> = NonNullable<Field<Field<T, 'parameters'>, K>>;
type RequiredKeys<T> = {
  [K in keyof T]-?: {} extends Pick<T, K> ? never : K;
}[keyof T];

type ParameterOption<T, K extends 'path' | 'query'> = [Parameter<T, K>] extends [never]
  ? { [Key in K]?: never }
  : RequiredKeys<Parameter<T, K>> extends never
    ? { [Key in K]?: Parameter<T, K> }
    : { [Key in K]: Parameter<T, K> };
type Content<T> = T extends { content: infer C } ? C[keyof C] : unknown;
type Body<T> = NonNullable<Field<T, 'requestBody'>>;
type BodyValue<T> = Body<T> extends { content: infer C }
  ? 'multipart/form-data' extends keyof C
    ? FormData
    : C[keyof C]
  : never;
type BodyOption<T> = [Body<T>] extends [never]
  ? { body?: never }
  : T extends { requestBody: unknown }
    ? { body: BodyValue<T> }
    : { body?: BodyValue<T> };

export type RequestOptions<M extends Method, P extends ApiPath<M>> =
  ParameterOption<Operation<M, P>, 'path'> &
  ParameterOption<Operation<M, P>, 'query'> &
  BodyOption<Operation<M, P>> & {
    headers?: HeadersInit;
    signal?: AbortSignal;
  };
export type RequestArguments<M extends Method, P extends ApiPath<M>> =
  RequiredKeys<RequestOptions<M, P>> extends never
    ? [options?: RequestOptions<M, P>]
    : [options: RequestOptions<M, P>];

type SuccessContent<T> = {
  [K in keyof T]: K extends 204 | 205 | '204' | '205'
    ? undefined
    : `${K & (string | number)}` extends `2${string}`
      ? Content<T[K]>
      : never;
}[keyof T];
export type ApiResponse<M extends Method, P extends ApiPath<M>> =
  M extends 'HEAD' ? undefined : SuccessContent<Field<Operation<M, P>, 'responses'>>;
