async function main() {
	const usdt = await hre.ethers.getContractAt("MockToken", "0x3786495F5d8a83B7bacD78E2A0c61ca20722Cce3"); // Replace with your USDT address

	const tx = await usdt.approve("0x96D284aB481467367AE89CA21b0094B8E046A0Fa", "100000000000000"); // Replace with your HTLC address

	await tx.wait();

	console.log(`[Setup]: Approved USDT to be used by the HTLC contract`);
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
