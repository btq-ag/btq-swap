import { ethers } from 'hardhat';

async function main() {
    console.log("Starting");
	const HtlcNative = await hre.ethers.getContractFactory("HtlcNative");
    console.log("Factory created");
    const htlc = await HtlcNative.attach("0x0eE7dE6Cd04EAD882F503c086f9b4e375A3ee337"); // Replace with your deployed address

	console.log(
		`[Setup]: Attached to the HtlcNative contract at ${htlc.address}`,
	);

    const partyB = "0x3D4D9A7123cbF8d1F73408db14b3231Be47ed74A";
    const secret = "0x1234567890123456789012345678901234567890123456789012345678901234";
    const secretHash = ethers.utils.solidityKeccak256(["bytes32"], [secret]);

    const currentBlock = await hre.ethers.provider.getBlock("latest");
    const currentBlockTimestamp = currentBlock.timestamp;

    const deadline = currentBlockTimestamp + (60 * 60 * 24);
    const otherNetwork = "BTQ";
    const otherAsset = "BTQ";
    const otherAmount = ethers.utils.parseEther("1");

    const amount = "1000000000000000000"; // 1 ETH
    
    const tx = await htlc.createHTLCProposal(
        partyB, 
        secretHash, 
        deadline, 
        otherNetwork,
        otherAsset,
        otherAmount,
        { value: amount }
    );
    await tx.wait();

    console.log("Funds locked successfully");
    console.log("Tx hash is: ", tx.hash);
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
