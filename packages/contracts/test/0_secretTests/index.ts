import { ethers } from "hardhat";
import { expect } from "chai";
import { MockToken, HtlcERC20 } from "../../typechain";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";

describe("Testing the HTLC' secret functionality", function () {
	let tokenA: MockToken;
	let tokenB: MockToken;
	let htlc: HtlcERC20;
	let partyA: SignerWithAddress;
	let partyB: SignerWithAddress;
	let deadlineA: number;
	let deadlineB: number;

	beforeEach(async function () {
		const Token = await hre.ethers.getContractFactory("MockToken");
		[partyA, partyB] = await hre.ethers.getSigners();

		tokenA = await Token.deploy("Mock aDAI", "aDai", 18);
		tokenB = await Token.deploy("Mock aWrappedBitcoin", "aWBTC", 18);
		await tokenA.deployed();
		await tokenB.deployed();

		const HtlcERC20 = await hre.ethers.getContractFactory("HtlcERC20");
		htlc = await HtlcERC20.deploy();
		await htlc.deployed();

		await tokenA.mint(partyA.address, hre.ethers.utils.parseEther("100"));
		await tokenB.mint(partyB.address, hre.ethers.utils.parseEther("100"));

		await tokenA
			.connect(partyA)
			.approve(htlc.address, hre.ethers.utils.parseEther("50"));

		await tokenB
			.connect(partyB)
			.approve(htlc.address, hre.ethers.utils.parseEther("0.001"));

		deadlineA = Math.floor(Date.now() / 1000) + 60 * 60 * 5;
		deadlineB = Math.floor(Date.now() / 1000) + 60 * 60 * 3;
	});

	it("Should handle a long secret for atomic swaps", async function () {
		const secretSeed = "mysecuresecret!!!#@904saljkd";
		const bytes32EncodedSecret = ethers.utils.sha256(
			ethers.utils.toUtf8Bytes(secretSeed),
		);
		const secretHash = ethers.utils.sha256(bytes32EncodedSecret);

		const createHTLCProposalA = await htlc
			.connect(partyA)
			.createHTLCProposal({
				partyB: partyB.address,
				secretlock: secretHash,
				deadline: deadlineA,
				erc20Contract: tokenA.address,
				tokenAmount: ethers.utils.parseEther("50"),
				otherNetwork: "BTQ",
				otherAsset: "BTQ",
				otherAmount: ethers.utils.parseEther("1"),
			});

		const txReceiptA = await createHTLCProposalA.wait();
		const proposalCreatedEventA = txReceiptA?.events?.find(
			(event) => event.event === "HTLCERC20Lockup",
		);

		const proposalIdA = proposalCreatedEventA?.args?.agreementId;

		const createHTLCProposalB = await htlc
			.connect(partyB)
			.createHTLCProposal({
				partyB: partyA.address,
				secretlock: secretHash,
				deadline: deadlineB,
				erc20Contract: tokenB.address,
				tokenAmount: ethers.utils.parseEther("0.001"),
				otherNetwork: "Ethereum",
				otherAsset: "aDAI",
				otherAmount: ethers.utils.parseEther("50"),
			});

		const txReceiptB = await createHTLCProposalB.wait();
		const proposalCreatedEventB = txReceiptB?.events?.find(
			(event) => event.event === "HTLCERC20Lockup",
		);

		const proposalIdB = proposalCreatedEventB?.args?.agreementId;

		expect(
			await htlc.connect(partyA).withdrawTokens(proposalIdB, bytes32EncodedSecret),
		).to.not.be.reverted;
		expect(
			await htlc.connect(partyB).withdrawTokens(proposalIdA, bytes32EncodedSecret),
		).to.not.be.reverted;
	});

	it("Should handle a small secret seed for atomic swaps", async function () {
		const secretSeed = "a";
		const bytes32EncodedSecret = ethers.utils.sha256(
			ethers.utils.toUtf8Bytes(secretSeed),
		);
		const secretHash = ethers.utils.sha256(bytes32EncodedSecret);

		const createHTLCProposalA = await htlc
			.connect(partyA)
			.createHTLCProposal({
				partyB: partyB.address,
				secretlock: secretHash,
				deadline: deadlineA,
				erc20Contract: tokenA.address,
				tokenAmount: ethers.utils.parseEther("50"),
				otherNetwork: "BTQ",
				otherAsset: "BTQ",
				otherAmount: ethers.utils.parseEther("1"),
			});

		const txReceiptA = await createHTLCProposalA.wait();
		const proposalCreatedEventA = txReceiptA?.events?.find(
			(event) => event.event === "HTLCERC20Lockup",
		);

		const proposalIdA = proposalCreatedEventA?.args?.agreementId;

		const createHTLCProposalB = await htlc
			.connect(partyB)
			.createHTLCProposal({
				partyB: partyA.address,
				secretlock: secretHash,
				deadline: deadlineB,
				erc20Contract: tokenB.address,
				tokenAmount: ethers.utils.parseEther("0.001"),
				otherNetwork: "Ethereum",
				otherAsset: "aDAI",
				otherAmount: ethers.utils.parseEther("50"),
			});

		const txReceiptB = await createHTLCProposalB.wait();
		const proposalCreatedEventB = txReceiptB?.events?.find(
			(event) => event.event === "HTLCERC20Lockup",
		);

		const proposalIdB = proposalCreatedEventB?.args?.agreementId;

		expect(
			await htlc.connect(partyA).withdrawTokens(proposalIdB, bytes32EncodedSecret),
		).to.not.be.reverted;
		expect(
			await htlc.connect(partyB).withdrawTokens(proposalIdA, bytes32EncodedSecret),
		).to.not.be.reverted;
	});

	it("Should handle secrets with strange characters", async function () {
		const secretSeed =
			"😄 😄 😄 😄 😄 text😄 🥸 🤩 🥳some more text 😏 😒 😞 😔 😟 h̸̢̤͓̫̳̰͇͓̘̫͗͒̈͂͒̽͊̂͂͂͐̀́͘e̶̛̖̿͐̌̈́̍͒̅̿̑̑͆̂͝ ̴̤̤̟͍͍̝̜̗͉͖̝̾̔̐̀̍̔̊̆̀̈́̍͜ͅc̴͉̼̥͚̱̱̍ò̷̢̖͇̞̭̲̹̽̓̂̍͝m̸͍͇̙͎̱̥̺͉͇̈́̇̋̊̈́̈͆̄̚͜e̷̺͚͙̼͙̭̞̣̩̘̟̱̜͓̥͊̒̈́̽̿͊̉̓̀̂̕͠͝͝s̶̡͔̣͓̗̫̤͓̗̹͉̭̹͚̐̐̊̿͒͛̄͋̉͋́̈́͜͠😕 🙁 ☹️ 😣 😖 😫 😩 🥺 😢 😭 ";
		const bytes32EncodedSecret = ethers.utils.sha256(
			ethers.utils.toUtf8Bytes(secretSeed),
		);
		const secretHash = ethers.utils.sha256(bytes32EncodedSecret);

		const createHTLCProposalA = await htlc
			.connect(partyA)
			.createHTLCProposal({
				partyB: partyB.address,
				secretlock: secretHash,
				deadline: deadlineA,
				erc20Contract: tokenA.address,
				tokenAmount: ethers.utils.parseEther("50"),
				otherNetwork: "BTQ",
				otherAsset: "BTQ",
				otherAmount: ethers.utils.parseEther("1"),
			});

		const txReceiptA = await createHTLCProposalA.wait();
		const proposalCreatedEventA = txReceiptA?.events?.find(
			(event) => event.event === "HTLCERC20Lockup",
		);

		const proposalIdA = proposalCreatedEventA?.args?.agreementId;

		const createHTLCProposalB = await htlc
			.connect(partyB)
			.createHTLCProposal({
				partyB: partyA.address,
				secretlock: secretHash,
				deadline: deadlineB,
				erc20Contract: tokenB.address,
				tokenAmount: ethers.utils.parseEther("0.001"),
				otherNetwork: "Ethereum",
				otherAsset: "aDAI",
				otherAmount: ethers.utils.parseEther("50"),
			});

		const txReceiptB = await createHTLCProposalB.wait();
		const proposalCreatedEventB = txReceiptB?.events?.find(
			(event) => event.event === "HTLCERC20Lockup",
		);

		const proposalIdB = proposalCreatedEventB?.args?.agreementId;

		expect(
			await htlc.connect(partyA).withdrawTokens(proposalIdB, bytes32EncodedSecret),
		).to.not.be.reverted;
		expect(
			await htlc.connect(partyB).withdrawTokens(proposalIdA, bytes32EncodedSecret),
		).to.not.be.reverted;
	});

	it("Should successfully get the publicly exposed secret from the event topics after party A claims from party B", async function () {
		const secretSeed = "verysecuresecret*@()%$J$@)J@$#%_U";
		const bytes32EncodedSecret = ethers.utils.sha256(
			ethers.utils.toUtf8Bytes(secretSeed),
		);
		const secretHash = ethers.utils.sha256(bytes32EncodedSecret);

		const createHTLCProposalA = await htlc
			.connect(partyA)
			.createHTLCProposal({
				partyB: partyB.address,
				secretlock: secretHash,
				deadline: deadlineA,
				erc20Contract: tokenA.address,
				tokenAmount: ethers.utils.parseEther("50"),
				otherNetwork: "BTQ",
				otherAsset: "BTQ",
				otherAmount: ethers.utils.parseEther("1"),
			});

		const txReceiptA = await createHTLCProposalA.wait();
		const proposalCreatedEventA = txReceiptA?.events?.find(
			(event) => event.event === "HTLCERC20Lockup",
		);

		const proposalIdA = proposalCreatedEventA?.args?.agreementId;

		const createHTLCProposalB = await htlc
			.connect(partyB)
			.createHTLCProposal({
				partyB: partyA.address,
				secretlock: secretHash,
				deadline: deadlineB,
				erc20Contract: tokenB.address,
				tokenAmount: ethers.utils.parseEther("0.001"),
				otherNetwork: "Ethereum",
				otherAsset: "aDAI",
				otherAmount: ethers.utils.parseEther("50"),
			});

		const txReceiptB = await createHTLCProposalB.wait();
		const proposalCreatedEventB = txReceiptB?.events?.find(
			(event) => event.event === "HTLCERC20Lockup",
		);

		const proposalIdB = proposalCreatedEventB?.args?.agreementId;

		await htlc.connect(partyA).withdrawTokens(proposalIdB, bytes32EncodedSecret);

		const HTLCInstance = await htlc.connect(partyB).getHTLCInstance(proposalIdB);
		const publiclyAvailableSecret = HTLCInstance["key"];

		expect(
			await htlc
				.connect(partyB)
				.withdrawTokens(proposalIdA, publiclyAvailableSecret),
		).to.not.be.reverted;
	});

	it("Should fail with an incorrect secret", async function () {
		const secretSeed = "correct_secret";
		const incorrectSecretSeed = "incorrect_secret";
		const bytes32EncodedIncorrectSecret = ethers.utils.sha256(
			ethers.utils.toUtf8Bytes(incorrectSecretSeed),
		);
		const bytes32EncodedSecret = ethers.utils.sha256(
			ethers.utils.toUtf8Bytes(secretSeed),
		);
		const secretHash = ethers.utils.sha256(bytes32EncodedSecret);

		const createHTLCProposalA = await htlc
			.connect(partyA)
			.createHTLCProposal({
				partyB: partyB.address,
				secretlock: secretHash,
				deadline: deadlineA,
				erc20Contract: tokenA.address,
				tokenAmount: ethers.utils.parseEther("50"),
				otherNetwork: "BTQ",
				otherAsset: "BTQ",
				otherAmount: ethers.utils.parseEther("1"),
			});

		const txReceiptA = await createHTLCProposalA.wait();
		const proposalCreatedEventA = txReceiptA?.events?.find(
			(event) => event.event === "HTLCERC20Lockup",
		);

		const proposalIdA = proposalCreatedEventA?.args?.agreementId;

		await expect(
			htlc
				.connect(partyB)
				.withdrawTokens(proposalIdA, bytes32EncodedIncorrectSecret),
		).to.be.revertedWith("secretlock hash does not match");
	});

	it("Should unlock funds with correct secret", async function () {
		const secretSeed = "correct_secret";
		const bytes32EncodedSecret = ethers.utils.sha256(
			ethers.utils.toUtf8Bytes(secretSeed),
		);
		const secretHash = ethers.utils.sha256(bytes32EncodedSecret);

		const createHTLCProposalA = await htlc
			.connect(partyA)
			.createHTLCProposal({
				partyB: partyB.address,
				secretlock: secretHash,
				deadline: deadlineA,
				erc20Contract: tokenA.address,
				tokenAmount: ethers.utils.parseEther("50"),
				otherNetwork: "BTQ",
				otherAsset: "BTQ",
				otherAmount: ethers.utils.parseEther("1"),
			});

		const txReceiptA = await createHTLCProposalA.wait();
		const proposalCreatedEventA = txReceiptA?.events?.find(
			(event) => event.event === "HTLCERC20Lockup",
		);

		const proposalIdA = proposalCreatedEventA?.args?.agreementId;

		await expect(
			htlc.connect(partyB).withdrawTokens(proposalIdA, bytes32EncodedSecret),
		).to.not.be.reverted;
	});
});
