import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with account:", deployer.address);
  console.log("Balance:", ethers.utils.formatEther(await deployer.getBalance()), "ETH\n");

  // 1. Deploy MockUSDT (6 decimals, 10M supply)
  const initialSupply = ethers.utils.parseUnits("10000000", 6);
  const MockUSDT = await ethers.getContractFactory("MockUSDT");
  const usdt = await MockUSDT.deploy(initialSupply);
  await usdt.deployed();
  console.log("MockUSDT deployed to:", usdt.address);

  // 2. Deploy HtlcERC20
  const HtlcERC20 = await ethers.getContractFactory("HtlcERC20");
  const htlcErc20 = await HtlcERC20.deploy();
  await htlcErc20.deployed();
  console.log("HtlcERC20 deployed to:", htlcErc20.address);

  // 3. Deploy HtlcNative
  const HtlcNative = await ethers.getContractFactory("HtlcNative");
  const htlcNative = await HtlcNative.deploy();
  await htlcNative.deployed();
  console.log("HtlcNative deployed to:", htlcNative.address);

  console.log("\n=== Deployment Summary ===");
  console.log(`USDT_TOKEN_ADDRESS=${usdt.address}`);
  console.log(`HTLC_CONTRACT_ADDRESS=${htlcErc20.address}`);
  console.log(`HTLC_NATIVE_ADDRESS=${htlcNative.address}`);
  console.log(`PLATFORM_ETH_ADDRESS=${deployer.address}`);

  console.log("\nUpdate your .env with these values.");
  console.log("Hardhat account #0 private key: 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
