import { createConfig, http } from 'wagmi';
import { hardhat, mainnet } from 'wagmi/chains';
import { connectorsForWallets } from '@rainbow-me/rainbowkit';
import { metaMaskWallet, injectedWallet } from '@rainbow-me/rainbowkit/wallets';

const connectors = connectorsForWallets(
  [
    {
      groupName: 'Recommended',
      wallets: [metaMaskWallet, injectedWallet],
    },
  ],
  {
    appName: 'BTQ Swap',
    projectId: 'none',
  },
);

export const wagmiConfig = createConfig({
  connectors,
  chains: [hardhat, mainnet],
  transports: {
    [hardhat.id]: http('http://127.0.0.1:8545'),
    [mainnet.id]: http('https://rpc.ankr.com/eth'),
  },
  ssr: false,
});
