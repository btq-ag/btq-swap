import { ethers } from 'hardhat';

async function main() {
    console.log("Starting");

    const secretSeed = "mysecuresecret!!!#@904saljkd0.9161197654693252";
	const bytes32EncodedSecret = ethers.utils.sha256(
		ethers.utils.toUtf8Bytes(secretSeed),
	);

    const htlcAgreementId = "0x4b6bee6ad2678a1a90e8e2e8cbd050ee91c543a211b25f7fcfc33acbbbd83c76"; // Replace with actual agreement ID
    console.log(`Secret is: ${bytes32EncodedSecret}`);
    const HtlcNative = await hre.ethers.getContractFactory("HtlcNative");
    const htlc = await HtlcNative.attach("0x098D1DC7D19872450e817348b8C6d739AEb2598f"); // Replace with your deployed address

    console.log("Claiming HTLC proposal...");
    const tx = await htlc.withdraw(htlcAgreementId, bytes32EncodedSecret);
    await tx.wait();

    console.log("Funds withdrawn successfully");
    console.log("Tx hash is:", tx.hash);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
