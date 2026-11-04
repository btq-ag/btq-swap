const hre = require("hardhat");

async function main() {
	const Token = await hre.ethers.getContractFactory("MockToken");
	const tokenA = await Token.deploy("Mock aDAI", "aDai", 18);
	const tokenB = await Token.deploy("Mock aWrappedBitcoin", "aWBTC", 18);
	await tokenA.deployed();
	await tokenB.deployed();

	console.log(`------------------------------------------------------`);
	console.log(`Conducting initial setup!`);
	console.log(`------------------------------------------------------`);

	console.log(`[Setup]: Deployed the mock erc20 token contract`);

	const HtlcERC20 = await hre.ethers.getContractFactory("HtlcERC20");
	const htlc = await HtlcERC20.deploy();
	await htlc.deployed();

	console.log(`[Setup]: Deployed the HTLC contract`);

	const [partyA, partyB] = await hre.ethers.getSigners();

	console.log(`[Setup]: Got the signers`);

	await tokenA.mint(partyA.address, hre.ethers.utils.parseEther("100"));
	console.log(`[Setup]: Minted some mock aDai for Party A`);

	await tokenB.mint(partyB.address, hre.ethers.utils.parseEther("100"));
	console.log(`[Setup]: Minted some mock aWBTC for Party B`);
	console.log(`------------------------------------------------------`);
	console.log(`Setup Complete!`);
	console.log(`Now simulating the HTLC protocol!`);
	console.log(`------------------------------------------------------`);

	const partyAInitialbalanceA = await tokenA.balanceOf(partyA.address);
	const partyAInitialbalanceB = await tokenB.balanceOf(partyA.address);
	const partyBInitialbalanceA = await tokenA.balanceOf(partyB.address);
	const partyBInitialbalanceB = await tokenB.balanceOf(partyB.address);

	console.log(
		`[Party A]: aDai Balance of Party A: ${hre.ethers.utils.formatEther(partyAInitialbalanceA)} aDAI`,
	);
	console.log(
		`[Party A]: aWBTC Balance of Party A: ${hre.ethers.utils.formatEther(partyAInitialbalanceB)} aWBTC`,
	);
	console.log(
		`[Party B]: aDai Balance of Party B: ${hre.ethers.utils.formatEther(partyBInitialbalanceA)} aDAI`,
	);
	console.log(
		`[Party B]: aWBTC Balance of Party B: ${hre.ethers.utils.formatEther(partyBInitialbalanceB)} aWBTC`,
	);

	await tokenA
		.connect(partyA)
		.approve(htlc.address, hre.ethers.utils.parseEther("50"));
	console.log(`[Party A]: Approved tokens`);

	await tokenB
		.connect(partyB)
		.approve(htlc.address, hre.ethers.utils.parseEther("0.001"));
	console.log(`[Party B]: Approved tokens`);

	const secretSeed = "mysecuresecret!!!#@904saljkd";
	const bytes32EncodedSecret = hre.ethers.utils.sha256(
		hre.ethers.utils.toUtf8Bytes(secretSeed),
	);

	const secretHash = hre.ethers.utils.sha256(bytes32EncodedSecret);
	const deadline = Math.floor(Date.now() / 1000) + 60 * 60 * 5;

	console.log(`[Party A]: Bytes32 encoded secret is  ${bytes32EncodedSecret}`);
	console.log(`[Party A]: Got secretHash ${secretHash}`);
	console.log(`[Party A]: Got deadline ${deadline}`);

	const createHTLCProposal = await htlc
		.connect(partyA)
		.createHTLCProposal({
			partyB: partyB.address,
			secretlock: secretHash,
			deadline: deadline,
			erc20Contract: tokenA.address,
			tokenAmount: hre.ethers.utils.parseEther("50"),
			otherNetwork: "BTQ",
			otherAsset: "BTQ",
			otherAmount: hre.ethers.utils.parseEther("1"),
		});

	console.log(`[Party A]: Party A created a new HTLC proposal`);

	const txReceipt = await createHTLCProposal.wait();
	const proposalCreatedEvent = txReceipt.events.find(
		(event: any) => event.event === "HTLCERC20Lockup",
	);
	const proposalId = proposalCreatedEvent.args.agreementId;

	console.log(`[Party A]: Got Party A's proposalId ${proposalId}`);

	console.log(`[Party A]: Party A waiting for Party B to lock...`);

	const deadlineB = Math.floor(Date.now() / 1000) + 60 * 60 * 3;

	console.log(`[Party B]: Party B approved 10 tokens`);

	const createHTLCProposalB = await htlc
		.connect(partyB)
		.createHTLCProposal({
			partyB: partyA.address,
			secretlock: secretHash,
			deadline: deadlineB,
			erc20Contract: tokenB.address,
			tokenAmount: hre.ethers.utils.parseEther("0.001"),
			otherNetwork: "Ethereum",
			otherAsset: "aDAI",
			otherAmount: hre.ethers.utils.parseEther("50"),
		});

	console.log(`[Party B]: Party B created a new HTLC proposal`);

	const txReceiptB = await createHTLCProposalB.wait();
	const proposalCreatedEventB = txReceiptB.events.find(
		(event: any) => event.event === "HTLCERC20Lockup",
	);
	const proposalIdB = proposalCreatedEventB.args.agreementId;

	console.log(`[Party B]: Got Party B's proposalId ${proposalIdB}`);

	await htlc.connect(partyA).withdrawTokens(proposalIdB, bytes32EncodedSecret);

	console.log(`[Party A]: Party A withdrew Party B's funds`);

	const HTLCInstance = await htlc.connect(partyB).getHTLCInstance(proposalIdB);
	const publiclyAvailableSecret = HTLCInstance["key"];

	console.log(
		`[Party B]: The publicly available secret is ${publiclyAvailableSecret}`,
	);

	await htlc.connect(partyB).withdrawTokens(proposalId, publiclyAvailableSecret);

	console.log(`[Party B]: Party B withdrew Party A's funds`);

	const partyAbalanceA = await tokenA.balanceOf(partyA.address);
	const partyAbalanceB = await tokenB.balanceOf(partyA.address);
	const partyBbalanceA = await tokenA.balanceOf(partyB.address);
	const partyBbalanceB = await tokenB.balanceOf(partyB.address);

	console.log(`------------------------------------------------------`);
	console.log(`Swap Complete!`);
	console.log(`Checking balances of participants`);
	console.log(`------------------------------------------------------`);

	console.log(
		`[Party A]: aDai Balance of Party A: ${hre.ethers.utils.formatEther(partyAbalanceA)} aDAI`,
	);
	console.log(
		`[Party A]: aWBTC Balance of Party A: ${hre.ethers.utils.formatEther(partyAbalanceB)} aWBTC`,
	);
	console.log(
		`[Party B]: aDai Balance of Party B: ${hre.ethers.utils.formatEther(partyBbalanceA)} aDAI`,
	);
	console.log(
		`[Party B]: aWBTC Balance of Party B: ${hre.ethers.utils.formatEther(partyBbalanceB)} aWBTC`,
	);
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
