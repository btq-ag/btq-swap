# Wagmi Hooks Guide (v3)

> For v2 docs, see https://2.x.wagmi.sh/react

## Account & Connection Hooks

### useAccount
```tsx
const {
  address,           // Connected address
  addresses,         // All connected addresses
  chain,            // Current chain
  chainId,          // Current chain ID
  connector,        // Active connector
  isConnected,
  isConnecting,
  isReconnecting,
  isDisconnected,
  status,           // 'connected' | 'connecting' | 'reconnecting' | 'disconnected'
} = useAccount()
```

### useConnectors (v3)
```tsx
// v3: Use useConnectors() to get available connectors
const connectors = useConnectors()

// Returns array of configured connectors
connectors.map(c => c.name) // ['MetaMask', 'Coinbase Wallet', ...]
```

### useConnect
```tsx
const {
  connect,          // Connect function
  connectAsync,     // Async version (returns promise)
  // Note: connectors removed in v3, use useConnectors() instead
  data,            // Connection result
  error,
  isPending,
  isSuccess,
  reset,           // Reset state
} = useConnect()

// Usage with useConnectors
const connectors = useConnectors()
connect({ connector: connectors[0] })

// With callback
connect(
  { connector },
  {
    onSuccess: (data) => console.log('Connected', data),
    onError: (error) => console.error('Failed', error),
  }
)
```

### useDisconnect
```tsx
const { disconnect, disconnectAsync, isPending } = useDisconnect()

disconnect() // Disconnect current connector
```

### useChainId
```tsx
const chainId = useChainId() // Current chain ID
```

### useChains (v3)
```tsx
// v3: Use useChains() to get configured chains
const chains = useChains()

// Returns array of configured chains
chains.map(c => c.name) // ['Ethereum', 'Polygon', ...]
```

### useSwitchChain
```tsx
const { switchChain, isPending, error } = useSwitchChain()
// Note: chains removed in v3, use useChains() instead

const chains = useChains()
switchChain({ chainId: 137 }) // Switch to Polygon
```

## Read Hooks

### useReadContract
```tsx
const {
  data,
  error,
  isLoading,        // First load
  isFetching,       // Any fetch (including refetch)
  isSuccess,
  isError,
  refetch,
  status,
} = useReadContract({
  address: '0x...',
  abi,
  functionName: 'balanceOf',
  args: ['0x...'],
  chainId: 1,                    // Optional: specific chain
  query: {
    enabled: true,               // Conditional fetching
    refetchInterval: 5000,       // Poll every 5s
    staleTime: 1000,            // Cache for 1s
    gcTime: 5 * 60 * 1000,      // Garbage collect after 5min
  },
})
```

### useReadContracts (Multicall)
```tsx
const { data } = useReadContracts({
  contracts: [
    {
      address: '0x...',
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: ['0x...'],
    },
    {
      address: '0x...',
      abi: erc20Abi,
      functionName: 'totalSupply',
    },
  ],
  query: { enabled: true },
})

// data[0].result, data[1].result
// data[0].status === 'success' | 'failure'
```

### useBalance
```tsx
const { data } = useBalance({
  address: '0x...',
  token: '0x...', // Optional: ERC20 address
  chainId: 1,
})

// data.value (bigint), data.formatted, data.symbol, data.decimals
```

### useBlockNumber
```tsx
const { data: blockNumber } = useBlockNumber({
  watch: true,              // Auto-update
  query: { refetchInterval: 1000 },
})
```

## Write Hooks

### useWriteContract
```tsx
const {
  data: hash,       // Transaction hash
  writeContract,    // Fire-and-forget
  writeContractAsync, // Returns promise
  error,
  isPending,
  isSuccess,
  reset,
} = useWriteContract()

// Basic usage
writeContract({
  address: '0x...',
  abi,
  functionName: 'transfer',
  args: ['0x...', 1000n],
})

// With value (payable functions)
writeContract({
  ...params,
  value: parseEther('0.1'),
})

// Async with error handling
try {
  const hash = await writeContractAsync({ ... })
  console.log('Submitted:', hash)
} catch (error) {
  console.error('Failed:', error)
}
```

### useSimulateContract
```tsx
// Simulate before write
const { data: simulation, error } = useSimulateContract({
  address: '0x...',
  abi,
  functionName: 'transfer',
  args: ['0x...', 1000n],
  query: { enabled: amount > 0n },
})

const { writeContract } = useWriteContract()

// Use simulation result
function handleSubmit() {
  if (simulation?.request) {
    writeContract(simulation.request)
  }
}
```

### useWaitForTransactionReceipt
```tsx
const { data: hash, writeContract } = useWriteContract()

const {
  data: receipt,
  isLoading: isConfirming,
  isSuccess: isConfirmed,
} = useWaitForTransactionReceipt({
  hash,
})

// receipt.status === 'success' | 'reverted'
// receipt.blockNumber, receipt.gasUsed, etc.
```

## Signing Hooks

### useSignMessage
```tsx
const { signMessage, signMessageAsync, data: signature } = useSignMessage()

signMessage({ message: 'Hello World' })

// Or async
const sig = await signMessageAsync({ message: 'Hello World' })
```

### useSignTypedData
```tsx
const { signTypedData, data } = useSignTypedData()

signTypedData({
  domain: {
    name: 'My App',
    version: '1',
    chainId: 1,
    verifyingContract: '0x...',
  },
  types: {
    Person: [
      { name: 'name', type: 'string' },
      { name: 'wallet', type: 'address' },
    ],
  },
  primaryType: 'Person',
  message: {
    name: 'Bob',
    wallet: '0x...',
  },
})
```

## Event Hooks

### useWatchContractEvent
```tsx
useWatchContractEvent({
  address: '0x...',
  abi,
  eventName: 'Transfer',
  args: {
    from: '0x...', // Filter by from address
  },
  onLogs: (logs) => {
    logs.forEach(log => {
      console.log(log.args.from, log.args.to, log.args.value)
    })
  },
  onError: (error) => console.error(error),
})
```

## ENS Hooks

### useEnsName
```tsx
const { data: ensName } = useEnsName({
  address: '0x...',
})
// 'vitalik.eth'
```

### useEnsAddress
```tsx
const { data: address } = useEnsAddress({
  name: 'vitalik.eth',
})
```

### useEnsAvatar
```tsx
const { data: avatarUrl } = useEnsAvatar({
  name: 'vitalik.eth',
})
```

## Utility Hooks

### useClient
```tsx
// Access underlying viem client
import { useClient } from 'wagmi'

const client = useClient()
// Use viem methods directly: client.readContract(...)
```

### usePublicClient
```tsx
import { usePublicClient } from 'wagmi'

const publicClient = usePublicClient()
// Direct viem access for custom operations
```

### useWalletClient
```tsx
import { useWalletClient } from 'wagmi'

const { data: walletClient } = useWalletClient()
// Direct viem wallet client access
```
