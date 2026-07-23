/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CONTRACT_ADDRESS: string
  readonly VITE_RPC_URL: string
  readonly VITE_CHAIN: 'localnet' | 'studionet' | 'testnetBradbury'
  readonly VITE_PRIVATE_KEY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

interface Window {
  ethereum?: {
    request: (args: { method: string; params?: unknown[] }) => Promise<unknown>
    on?: (event: string, handler: (...args: unknown[]) => void) => void
    removeListener?: (event: string, handler: (...args: unknown[]) => void) => void
  }
}
