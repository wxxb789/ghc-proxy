export function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
  return Boolean(value)
    && typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === 'function'
}
