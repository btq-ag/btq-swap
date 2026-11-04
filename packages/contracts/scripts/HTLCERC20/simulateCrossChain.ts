const { ethers } = require("hardhat");

const htlcAddresses = {
	sepolia: "0x2f08c366aC7380807cD1B7bc58fD6022c2093606",
	arbitrumSepolia: "0x0000000000000000000000000000000000000000", // Replace after deployment
};

const mockTokenAddresses = {
	sepolia: "0x9B2bF9c76C2008222Bc35BBc7eE11432E13AF4Fe",
	arbitrumSepolia: "0x0000000000000000000000000000000000000000", // Replace after deployment
};

const userEOAs = {
	Alice: "0x01735c575C171a060Be7Ec4aA30b409435Cdcd65",
	Bob: "0xd298F104d267524a3787E3d8793786AB1C562a6c",
};

async function checkBalance(
	network: string,
	tokenAddress: string,
	userName: string,
	userAddress: string,
	rpcUrl: string,
) {
	const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
	const tokenContract = new ethers.Contract(
		tokenAddress,
		["function balanceOf(address) view returns (uint256)"],
		provider,
	);
	const balance = await tokenContract.balanceOf(userAddress);
	console.log(
		`[${network}]: Balance of ${userName} (${userAddress}) is ${ethers.utils.formatEther(
			balance,
		)} Mock Tokens`,
	);
}

async function main() {
	var providerSepolia = new ethers.providers.JsonRpcProvider(
		process.env.SEPOLIA_RPC_URL,
	);
	var providerArbitrumSepolia = new ethers.providers.JsonRpcProvider(
		process.env.ARBITRUM_SEPOLIA_RPC_URL,
	);

	console.log(`------------------------------------------------------`);
	console.log(`Checking balances of participants`);
	console.log(`------------------------------------------------------`);
	await checkBalance(
		"sepolia",
		mockTokenAddresses.sepolia,
		"Alice",
		userEOAs.Alice,
		process.env.SEPOLIA_RPC_URL || "",
	);
	await checkBalance(
		"arbitrumSepolia",
		mockTokenAddresses.arbitrumSepolia,
		"Alice",
		userEOAs.Alice,
		process.env.ARBITRUM_SEPOLIA_RPC_URL || "",
	);
	await checkBalance(
		"sepolia",
		mockTokenAddresses.sepolia,
		"Bob",
		userEOAs.Bob,
		process.env.SEPOLIA_RPC_URL || "",
	);
	await checkBalance(
		"arbitrumSepolia",
		mockTokenAddresses.arbitrumSepolia,
		"Bob",
		userEOAs.Bob,
		process.env.ARBITRUM_SEPOLIA_RPC_URL || "",
	);

	console.log(`------------------------------------------------------`);
	console.log(
		`Setting up cross-chain swap: [Tokens on Ethereum Sepolia <---> Tokens on Arbitrum Sepolia]`,
	);
	console.log(`------------------------------------------------------`);

	const secretSeed = "mysecuresecret!!!#@904saljkd";
	const bytes32EncodedSecret = ethers.utils.sha256(
		ethers.utils.toUtf8Bytes(secretSeed),
	);
	const secretHash = ethers.utils.sha256(bytes32EncodedSecret);

	console.log("[sepolia]: Alice secret plain text " + secretSeed);
	console.log("[sepolia]: Alice created secret bytes32 " + bytes32EncodedSecret);
	console.log("[sepolia]: Alice created secret hash " + secretHash);

	var AliceWallet = new ethers.Wallet(
		process.env.PRIVATE_KEY_ALICE,
		providerSepolia,
	);
	var BobWallet = new ethers.Wallet(
		process.env.PRIVATE_KEY_BOB,
		providerArbitrumSepolia,
	);

	const mockTokenSepolia = await ethers.getContractAt(
		"IERC20",
		mockTokenAddresses.sepolia,
		AliceWallet,
	);
	const mockTokenArbitrumSepolia = await ethers.getContractAt(
		"IERC20",
		mockTokenAddresses.arbitrumSepolia,
		BobWallet,
	);

	const approveAliceTx = await mockTokenSepolia
		.connect(AliceWallet)
		.approve(htlcAddresses.sepolia, ethers.utils.parseEther("0.0001"), {
			gasPrice: 80000000000,
		});
	console.log(
		"[sepolia]: Alice Approval Transaction hash:",
		approveAliceTx.hash,
	);
	await approveAliceTx.wait();
	console.log("[sepolia]: Alice Approval Transaction confirmed");

	const approveBobTx = await mockTokenArbitrumSepolia
		.connect(BobWallet)
		.approve(htlcAddresses.arbitrumSepolia, ethers.utils.parseEther("0.0001"));
	console.log(
		"[arbitrumSepolia]: Bob Approval Transaction hash:",
		approveBobTx.hash,
	);
	await approveBobTx.wait();
	console.log("[arbitrumSepolia]: Bob Approval Transaction confirmed");

	const deadlineAlice = Math.floor(Date.now() / 1000) + 60 * 60 * 5;
	console.log("[sepolia]: Alice deadline is " + deadlineAlice);

	const htlcERC20Sepolia = await ethers.getContractAt(
		"HtlcERC20",
		htlcAddresses.sepolia,
		AliceWallet,
		providerSepolia,
	);
	const htlcERC20Arbitrum = await ethers.getContractAt(
		"HtlcERC20",
		htlcAddresses.arbitrumSepolia,
		BobWallet,
		providerArbitrumSepolia,
	);

	console.log(`------------------------------------------------------`);
	console.log(`Creating HTLC Instance on Sepolia`);
	console.log(`------------------------------------------------------`);

	const createHTLCProposalA = await htlcERC20Sepolia
		.connect(AliceWallet)
		.createHTLCProposal({
			partyB: userEOAs.Bob,
			secretlock: secretHash,
			deadline: deadlineAlice,
			erc20Contract: mockTokenAddresses.sepolia,
			tokenAmount: ethers.utils.parseEther("0.0001"),
			otherNetwork: "Arbitrum Sepolia",
			otherAsset: "MCK",
			otherAmount: ethers.utils.parseEther("0.0001"),
		}, { gasPrice: 80000000000 });
	console.log(
		"[sepolia]: Alice created a new HTLC proposal on sepolia. Transaction hash: ",
		createHTLCProposalA.hash,
	);

	const txReceiptA = await createHTLCProposalA.wait();

	console.log("[sepolia]: Transaction confirmed");

	const proposalCreatedEventA = txReceiptA.events.find(
		(event: any) => event.event === "HTLCERC20Lockup",
	);
	const proposalIdA = proposalCreatedEventA.args.agreementId;
	console.log(`[sepolia]: Got Alice's proposalId ${proposalIdA}`);

	const deadlineBob = Math.floor(Date.now() / 1000) + 60 * 60 * 3;

	console.log(`------------------------------------------------------`);
	console.log(`Creating HTLC Instance on Arbitrum Sepolia`);
	console.log(`------------------------------------------------------`);

	const createHTLCProposalB = await htlcERC20Arbitrum
		.connect(BobWallet)
		.createHTLCProposal({
			partyB: userEOAs.Alice,
			secretlock: secretHash,
			deadline: deadlineBob,
			erc20Contract: mockTokenAddresses.arbitrumSepolia,
			tokenAmount: ethers.utils.parseEther("0.0001"),
			otherNetwork: "Sepolia",
			otherAsset: "MCK",
			otherAmount: ethers.utils.parseEther("0.0001"),
		});
	console.log(
		"[arbitrumSepolia]: Bob created a new HTLC proposal. Transaction hash: ",
		createHTLCProposalB.hash,
	);

	const txReceiptB = await createHTLCProposalB.wait();

	console.log("[arbitrumSepolia]: Transaction confirmed");

	const proposalCreatedEventB = txReceiptB.events.find(
		(event: any) => event.event === "HTLCERC20Lockup",
	);
	const proposalIdB = proposalCreatedEventB.args.agreementId;

	console.log(`[arbitrumSepolia]: Got Bob's proposalId ${proposalIdB}`);

	console.log(`------------------------------------------------------`);
	console.log(`Resolving HTLC Transaction on Both Chains`);
	console.log(`------------------------------------------------------`);

	AliceWallet = new ethers.Wallet(
		process.env.PRIVATE_KEY_ALICE,
		providerArbitrumSepolia,
	);
	console.log(
		`[arbitrumSepolia]: Set Alice's wallet to arbitrumSepolia ${AliceWallet.address}`,
	);

	const withdrawTxA = await htlcERC20Arbitrum
		.connect(AliceWallet)
		.withdrawTokens(proposalIdB, bytes32EncodedSecret);

	console.log(
		`[arbitrumSepolia]: Alice withdrawing Bob's funds. Transaction hash: `,
		withdrawTxA.hash,
	);

	await withdrawTxA.wait();

	console.log(`[arbitrumSepolia]: Transaction confirmed`);
	console.log(
		`[arbitrumSepolia]: Bob can now grab the revealed secret from the HTLCInstance`,
	);

	const HTLCInstance = await htlcERC20Arbitrum
		.connect(BobWallet)
		.getHTLCInstance(proposalIdB);

	console.log(
		`[arbitrumSepolia]: Got the HTLCInstance from proposalId ${proposalIdB} to get the exposed secret`,
	);

	const publiclyAvailableSecret = HTLCInstance["key"];

	console.log(
		`[arbitrumSepolia]: The publicly available secret is ${publiclyAvailableSecret}`,
	);

	BobWallet = new ethers.Wallet(process.env.PRIVATE_KEY_BOB, providerSepolia);
	console.log(`[sepolia]: Set Bob's wallet to sepolia ${BobWallet.address}`);

	const withdrawTxB = await htlcERC20Sepolia
		.connect(BobWallet)
		.withdrawTokens(proposalIdA, publiclyAvailableSecret, {
			gasPrice: 80000000000,
		});

	await withdrawTxB.wait();

	console.log(
		`[sepolia]: Bob withdrew Alice's funds on Sepolia. Transaction hash: `,
		withdrawTxB.hash,
	);

	console.log(`------------------------------------------------------`);
	console.log(`Atomic Swap Complete!`);
	console.log(`Checking balances of participants`);
	console.log(`------------------------------------------------------`);

	await checkBalance(
		"sepolia",
		mockTokenAddresses.sepolia,
		"Alice",
		userEOAs.Alice,
		process.env.SEPOLIA_RPC_URL || "",
	);
	await checkBalance(
		"arbitrumSepolia",
		mockTokenAddresses.arbitrumSepolia,
		"Alice",
		userEOAs.Alice,
		process.env.ARBITRUM_SEPOLIA_RPC_URL || "",
	);
	await checkBalance(
		"sepolia",
		mockTokenAddresses.sepolia,
		"Bob",
		userEOAs.Bob,
		process.env.SEPOLIA_RPC_URL || "",
	);
	await checkBalance(
		"arbitrumSepolia",
		mockTokenAddresses.arbitrumSepolia,
		"Bob",
		userEOAs.Bob,
		process.env.ARBITRUM_SEPOLIA_RPC_URL || "",
	);
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
