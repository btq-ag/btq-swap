import { ethers } from 'hardhat';

async function main() {
    console.log("Starting");

    const secretSeed = "mysecuresecret!!!#@904saljkd";
	const bytes32EncodedSecret = ethers.utils.sha256(
		ethers.utils.toUtf8Bytes(secretSeed),
	);
	const secretHash = ethers.utils.sha256(bytes32EncodedSecret);

    const currentBlock = await ethers.provider.getBlock("latest");
    const currentBlockTimestamp = currentBlock.timestamp;
    const deadline = currentBlockTimestamp + (60 * 5);
    console.log(`Calculated deadline: ${deadline}`);

    const deadline32 = Math.floor(deadline);
    if (deadline32 > 0xFFFFFFFF) {
        throw new Error('Deadline exceeds 32-bit limit.');
    }

    const tokenAmount = ethers.utils.parseUnits("1.015", 6);
    console.log(`Token amount: ${tokenAmount.toString()}`);

    const otherNetwork = "BTQ";
    const otherAsset = "BTQ";
    const otherAmount = ethers.utils.parseUnits("0.01", 18);

    const erc20ContractAddress = "0x956d617f50fA0d7Ae2dB389EDD9216CBC0a5Bfa1"; // USDT contract address
    const erc20Contract = await ethers.getContractAt("IERC20", erc20ContractAddress);

    const htlcAddress = "0x96D284aB481467367AE89CA21b0094B8E046A0Fa"; // Replace with your deployed HTLC address

    console.log("Setting allowance for HTLC contract...");
    const approveTx = await erc20Contract.approve(htlcAddress, tokenAmount);
    await approveTx.wait();
    console.log("Allowance set successfully.");

    const params = {
        partyB: "0x3D4D9A7123cbF8d1F73408db14b3231Be47ed74A",
        secretlock: secretHash,
        deadline: deadline32,
        erc20Contract: erc20ContractAddress,
        tokenAmount: tokenAmount,
        otherNetwork: otherNetwork,
        otherAsset: otherAsset,
        otherAmount: otherAmount
    };

    console.log("HTLCParams:", params);

    const HtlcERC20 = await ethers.getContractFactory("HtlcERC20");
    const htlc = HtlcERC20.attach(htlcAddress);

    console.log("Creating HTLC proposal...");
    const tx = await htlc.createHTLCProposal(params);
    await tx.wait();

    console.log("Funds locked successfully");
    console.log("Tx hash is:", tx.hash);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
