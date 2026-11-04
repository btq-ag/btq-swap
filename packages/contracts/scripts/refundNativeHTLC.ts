async function main() {
    console.log("Starting");
	const HtlcNative = await hre.ethers.getContractFactory("HtlcNative");
    console.log("Factory created");
    const htlc = await HtlcNative.attach("0x0eE7dE6Cd04EAD882F503c086f9b4e375A3ee337"); // Replace with your deployed address

	console.log(
		`[Setup]: Attached to the HtlcNative contract at ${htlc.address}`,
	);

    const agreementId = "0x38cc2822f0d7906daabada4a362ab2070b5ba8b855db3a5ebeecacc0a2ad3833"; // Replace with actual agreement ID

    const tx = await htlc.refundTokens(agreementId);
    await tx.wait();

    console.log("Funds refunded successfully");
    console.log("Tx hash is: ", tx.hash);
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
