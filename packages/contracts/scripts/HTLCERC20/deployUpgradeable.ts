/**
 * Deploy the HTLC contract via a factory pattern.
 * Requires an HtlcERC20Factory contract (not included by default).
 */

async function main() {
	const HtlcERC20 = await hre.ethers.getContractFactory("HtlcERC20");
	const htlc = await HtlcERC20.deploy();
	const deployedHTLC = await htlc.deployed();
	const deployedHTLCAddress = await deployedHTLC.getAddress();

	console.log(
		`[Setup]: Deployed the HTLC logic file to address ${deployedHTLCAddress}`,
	);

    const HtlcERC20Factory = await hre.ethers.getContractFactory("HtlcERC20Factory");
	const htlcFactory = await HtlcERC20Factory.deploy(deployedHTLCAddress);
	const deployedHTLCFactory = await htlcFactory.deployed();

	console.log(
		`[Setup]: Deployed the HTLC Factory contract to address ${deployedHTLCFactory.address}`,
	);
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
