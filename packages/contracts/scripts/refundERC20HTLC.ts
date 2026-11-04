async function main() {
    console.log("Starting");
	const HtlcERC20Instance = await hre.ethers.getContractFactory("HtlcERC20");
    console.log("Factory created");
    const htlc = await HtlcERC20Instance.attach("0x96D284aB481467367AE89CA21b0094B8E046A0Fa"); // Replace with your deployed address

	console.log(
		`[Setup]: Attached to the HtlcERC20 contract at ${htlc.address}`,
	);

    const agreementId = "0x0e244e4a33883f15078306fef076ebc1665815e0a4ec2beccfeac32c635e2fb5"; // Replace with actual agreement ID

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
