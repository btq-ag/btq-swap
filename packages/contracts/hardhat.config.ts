import { HardhatUserConfig } from "hardhat/config";
import "@typechain/hardhat";
import "@nomiclabs/hardhat-ethers";
import "@nomicfoundation/hardhat-toolbox";

import * as dotenv from "dotenv";

dotenv.config();

const PK = process.env.PRIVATE_KEY;
const accounts = PK ? [PK] : [];

const config: HardhatUserConfig = {
	solidity: {
		version: "0.8.20",
		settings: {
			optimizer: {
				enabled: true,
				runs: 200,
			},
			viaIR: true,
		},
	},
	typechain: {
		outDir: "typechain",
		target: "ethers-v5",
	},
	networks: {
		localhost: {
			url: "http://127.0.0.1:8545",
			gas: 30_000_000,
		},
		hardhat: {
			blockGasLimit: 60_000_000,
			gas: 60_000_000,
			allowUnlimitedContractSize: true,
		},
		sepolia: {
			url: `https://eth-sepolia.g.alchemy.com/v2/${process.env.SEPOLIA_ALCHEMY_KEY || ""}`,
			accounts,
		},
		arbitrumSepolia: {
			url: `https://arb-sepolia.g.alchemy.com/v2/${process.env.SEPOLIA_ALCHEMY_KEY || ""}`,
			accounts,
		},
		mainnet: {
			url: `https://eth-mainnet.g.alchemy.com/v2/${process.env.ETHEREUM_MAINNET_ALCHEMY_KEY || ""}`,
			accounts,
		},
	},
	etherscan: {
		apiKey: {
			mainnet: process.env.ETHERSCAN_API_KEY || "",
			sepolia: process.env.ETHERSCAN_API_KEY || "",
		},
	},
};

export default config;
