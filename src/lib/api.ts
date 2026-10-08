export class ApiError extends Error {
  status: number
  code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers)
  if ((options.method ?? 'GET').toUpperCase() !== 'GET') {
    headers.set('Content-Type', 'application/json')
    headers.set('X-Requested-With', 'excalidraw-demo')
  }
  const response = await fetch(path, { ...options, credentials: 'same-origin', headers })
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    throw new ApiError(response.status, body?.error?.code ?? 'REQUEST_FAILED', body?.error?.message ?? `请求失败（${response.status}）`)
  }
  return body as T
}
