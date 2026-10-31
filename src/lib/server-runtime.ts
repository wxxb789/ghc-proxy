import type { AnyElysia, ElysiaAdapter } from 'elysia'
import type { Server } from 'elysia/universal/server'
import { Elysia } from 'elysia'

const isBun = typeof globalThis.Bun !== 'undefined'

// Resolve once without evaluating the Node HTTP stack on Bun.
// eslint-disable-next-line antfu/no-top-level-await
const adapter: ElysiaAdapter | undefined = isBun ? undefined : (await import('@elysiajs/node')).node()

export interface RuntimeListener {
  readonly port: number
  readonly url: URL
  close: (closeActiveConnections?: boolean) => Promise<void>
}

interface NodeListener {
  raw: {
    ready: () => Promise<unknown>
    close: (closeActiveConnections?: boolean) => Promise<void>
    readonly url?: string
  }
}

export function createRuntimeApp(options?: { idleTimeout?: number }): Elysia {
  return new Elysia({
    adapter,
    // This CLI option is explicitly Bun-only; it is not a Node socket timeout.
    serve: isBun && options?.idleTimeout !== undefined
      ? { idleTimeout: options.idleTimeout }
      : undefined,
  })
}

/** Resolve only after binding; callers never need the adapter's listener shape. */
export async function listenRuntimeServer(
  app: Pick<AnyElysia, 'listen' | 'stop'>,
  options: { port: number, hostname?: string },
): Promise<RuntimeListener> {
  // The CLI owns signals. srvx's automatic handlers would race our close()
  // and can resolve a second close before in-flight responses have drained.
  const listenOptions = isBun ? options : { ...options, gracefulShutdown: false }
  const server = await new Promise<Server>((resolve) => {
    app.listen(listenOptions, resolve)
  })

  let url: URL
  let closeListener: RuntimeListener['close']
  if (isBun) {
    url = server.url
    closeListener = async (force) => {
      await app.stop(force)
    }
  }
  else {
    // @elysiajs/node exposes srvx through the listen callback, but does not
    // populate app.server, so Elysia's app.stop() cannot close this listener.
    const { raw } = server as unknown as NodeListener
    try {
      await raw.ready()
      if (!raw.url)
        throw new Error('The Node HTTP listener has no bound URL.')
      url = new URL(raw.url)
    }
    catch (error) {
      await raw.close(true)
      throw error
    }
    closeListener = force => raw.close(force)
  }

  let closing: Promise<void> | undefined
  return {
    port: Number(url.port || '80'),
    url,
    close: force => closing ??= closeListener(force),
  }
}
