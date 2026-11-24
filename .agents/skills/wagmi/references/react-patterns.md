# Wagmi React Patterns

## Next.js App Router Setup

### Provider with 'use client'
```tsx
// app/providers.tsx
'use client'

import { WagmiProvider } from 'wagmi'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { config } from '@/config'
import { useState } from 'react'

export function Providers({ children }: { children: React.ReactNode }) {
  // Create QueryClient inside component to avoid shared state
  const [queryClient] = useState(() => new QueryClient())

  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    </WagmiProvider>
  )
}
```

### Layout Integration
```tsx
// app/layout.tsx
import { Providers } from './providers'

export default function RootLayout({ children }) {
  return (
    <html>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
```

## SSR Hydration Handling

### Avoiding Hydration Mismatch
```tsx
'use client'

import { useAccount } from 'wagmi'
import { useEffect, useState } from 'react'

function WalletDisplay() {
  const { address, isConnected } = useAccount()
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  // Return placeholder during SSR
  if (!mounted) {
    return <div>Loading...</div>
  }

  return (
    <div>
      {isConnected ? `Connected: ${address}` : 'Not connected'}
    </div>
  )
}
```

### Suspense Boundaries
```tsx
import { Suspense } from 'react'

function App() {
  return (
    <Suspense fallback={<LoadingSpinner />}>
      <WalletFeatures />
    </Suspense>
  )
}
```

## State Management Patterns

### Optimistic Updates
```tsx
import { useWriteContract, useWaitForTransactionReceipt } from 'wagmi'
import { useState } from 'react'

function Transfer() {
  const [optimisticBalance, setOptimisticBalance] = useState<bigint | null>(null)
  const { data: hash, writeContract } = useWriteContract()
  const { isSuccess } = useWaitForTransactionReceipt({ hash })

  async function handleTransfer(amount: bigint) {
    // Optimistically update UI
    setOptimisticBalance(prev => (prev ?? 0n) - amount)
    
    writeContract({
      ...params,
      args: [recipient, amount],
    })
  }

  // Reset optimistic state on confirmation
  useEffect(() => {
    if (isSuccess) {
      setOptimisticBalance(null) // Let real data take over
    }
  }, [isSuccess])
}
```

### Form State with Contract Writes
```tsx
import { useWriteContract, useWaitForTransactionReceipt } from 'wagmi'
import { parseEther } from 'viem'

function TransferForm() {
  const [to, setTo] = useState('')
  const [amount, setAmount] = useState('')
  
  const { data: hash, writeContract, isPending, error } = useWriteContract()
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash })

  const isLoading = isPending || isConfirming

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    
    writeContract({
      address: '0x...',
      abi,
      functionName: 'transfer',
      args: [to as `0x${string}`, parseEther(amount)],
    })
  }

  return (
    <form onSubmit={handleSubmit}>
      <input 
        value={to} 
        onChange={e => setTo(e.target.value)}
        placeholder="Recipient"
        disabled={isLoading}
      />
      <input 
        value={amount} 
        onChange={e => setAmount(e.target.value)}
        placeholder="Amount"
        disabled={isLoading}
      />
      <button type="submit" disabled={isLoading || !to || !amount}>
        {isPending ? 'Confirming...' : isConfirming ? 'Processing...' : 'Transfer'}
      </button>
      {isSuccess && <div>Success! Hash: {hash}</div>}
      {error && <div>Error: {error.message}</div>}
    </form>
  )
}
```

## Error Handling Patterns

### Error Boundary for Web3
```tsx
'use client'

import { Component, ReactNode } from 'react'

interface Props {
  children: ReactNode
  fallback: ReactNode
}

interface State {
  hasError: boolean
  error?: Error
}

export class Web3ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback
    }
    return this.props.children
  }
}
```

### Hook-Level Error Handling
```tsx
function ContractReader() {
  const { data, error, isError } = useReadContract({
    ...params,
    query: {
      retry: 3,
      retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),
    },
  })

  if (isError) {
    // Parse contract errors
    if (error.message.includes('execution reverted')) {
      return <div>Contract call failed - check your inputs</div>
    }
    if (error.message.includes('network')) {
      return <div>Network error - please try again</div>
    }
    return <div>Error: {error.message}</div>
  }

  return <div>{data?.toString()}</div>
}
```

## Performance Patterns

### Memoizing Contract Configs
```tsx
import { useMemo } from 'react'

function TokenBalance({ tokenAddress, userAddress }) {
  // Memoize to prevent unnecessary re-renders
  const contractConfig = useMemo(() => ({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [userAddress],
  }), [tokenAddress, userAddress])

  const { data } = useReadContract(contractConfig)

  return <div>{data?.toString()}</div>
}
```

### Batching Reads
```tsx
function PortfolioBalances({ tokens, userAddress }) {
  const { data } = useReadContracts({
    contracts: tokens.map(token => ({
      address: token.address,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [userAddress],
    })),
    query: {
      // Only refetch on window focus, not continuously
      refetchOnWindowFocus: true,
      refetchInterval: false,
    },
  })

  return (
    <ul>
      {data?.map((result, i) => (
        <li key={tokens[i].address}>
          {tokens[i].symbol}: {result.result?.toString() ?? 'Error'}
        </li>
      ))}
    </ul>
  )
}
```

## Testing Patterns

### Mock Config for Tests
```tsx
// test-utils.tsx
import { createConfig, http } from 'wagmi'
import { mainnet } from 'wagmi/chains'
import { mock } from 'wagmi/connectors'

export const mockConfig = createConfig({
  chains: [mainnet],
  connectors: [
    mock({
      accounts: ['0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'],
    }),
  ],
  transports: {
    [mainnet.id]: http(),
  },
})

// In tests
render(
  <WagmiProvider config={mockConfig}>
    <QueryClientProvider client={new QueryClient()}>
      <YourComponent />
    </QueryClientProvider>
  </WagmiProvider>
)
```

## ConnectKit / RainbowKit Integration

### With ConnectKit
```tsx
import { ConnectKitProvider, ConnectKitButton } from 'connectkit'

function App() {
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <ConnectKitProvider>
          <ConnectKitButton />
          {/* Your app */}
        </ConnectKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  )
}
```

### With RainbowKit
```tsx
import { RainbowKitProvider, ConnectButton } from '@rainbow-me/rainbowkit'
import '@rainbow-me/rainbowkit/styles.css'

function App() {
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider>
          <ConnectButton />
          {/* Your app */}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  )
}
```
