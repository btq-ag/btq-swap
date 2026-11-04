async function main() {
	const HtlcERC20 = await hre.ethers.getContractFactory("HtlcERC20");
	const htlc = await HtlcERC20.deploy();
	const deployedHTLC = await htlc.deployed();

	console.log(
		`[Setup]: Deployed the HtlcERC20 contract to address ${deployedHTLC.address}`,
	);
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
