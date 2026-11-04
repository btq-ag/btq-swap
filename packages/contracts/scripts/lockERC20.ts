import { ethers } from 'hardhat';

async function main() {
    console.log("Starting");

    const secretSeed = "mysecuresecret!!!#@904saljkd" + Math.random();
    console.log("Secret seed is:", secretSeed);
	const bytes32EncodedSecret = ethers.utils.sha256(
		ethers.utils.toUtf8Bytes(secretSeed),
	);
	const secretHash = ethers.utils.sha256(bytes32EncodedSecret);

    const currentBlock = await ethers.provider.getBlock("latest");
    const currentBlockTimestamp = currentBlock.timestamp;
    const deadline = currentBlockTimestamp + (60 * 60 * 24);
    console.log(`Calculated deadline: ${deadline}`);

    const deadline32 = Math.floor(deadline);
    if (deadline32 > 0xFFFFFFFF) {
        throw new Error('Deadline exceeds 32-bit limit.');
    }

    const tokenAmount = ethers.utils.parseUnits("20", 6);
    console.log(`Token amount: ${tokenAmount.toString()}`);

    const otherNetwork = "BTQ";
    const otherAsset = "BTQ";
    const otherAmount = ethers.utils.parseUnits("0.01", 18);

    const erc20ContractAddress = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"; // USDC contract address
    const erc20Contract = await ethers.getContractAt("IERC20", erc20ContractAddress);

    const htlcAddress = "0x347c755319FF939EEC69d1A2218A1b74a07C43Ff"; // Replace with your deployed HTLC address

    console.log("Setting allowance for HTLC contract...");
    const allowance = await erc20Contract.allowance(
        await ethers.provider.getSigner().getAddress(),
        htlcAddress
    );
    if (allowance.lt(tokenAmount)) {
        console.log("Allowance is not enough. Resetting allowance to zero...");
        const resetTx = await erc20Contract.approve(htlcAddress, 0);
        await resetTx.wait();

        console.log("Setting the correct allowance...");
        const approveTx = await erc20Contract.approve(htlcAddress, tokenAmount);
        await approveTx.wait();
        console.log("Allowance set successfully.");
    }
    
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
