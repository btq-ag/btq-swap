async function main() {
	const HtlcNative = await hre.ethers.getContractFactory("HtlcNative");
	const htlc = await HtlcNative.deploy();
	const deployedHTLC = await htlc.deployed();

	console.log(
		`[Setup]: Deployed the HtlcNative contract to address ${deployedHTLC.address}`,
	);
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
