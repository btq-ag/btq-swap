import { ethers } from "hardhat";
import { expect } from "chai";
import { MockToken, HtlcERC20 } from "../../typechain";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";

describe("Testing flow outliers and unhappy paths", function () {
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

	it("Should not not allow an impossibly short lockup deadline", async function () {
		const currentBlock = await ethers.provider.getBlock("latest");
		const blockTime = currentBlock.timestamp;
		deadlineA = blockTime;

		const secretSeed = "correct_secret";
		const bytes32EncodedSecret = ethers.utils.sha256(
			ethers.utils.toUtf8Bytes(secretSeed),
		);
		const secretHash = ethers.utils.sha256(bytes32EncodedSecret);

		await expect(
			htlc
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
				}),
		).to.be.revertedWith("deadline time must be in the future");
	});

	it("Should not not allow a refund twice", async function () {
		const currentBlock = await ethers.provider.getBlock("latest");
		const blockTime = currentBlock.timestamp;

		deadlineA = blockTime + 3;

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

		await new Promise((resolve) => setTimeout(resolve, 5000));

		await ethers.provider.send("evm_mine", []);

		const proposalIdA = proposalCreatedEventA?.args?.agreementId;

		await expect(htlc.connect(partyA).refundTokens(proposalIdA)).to.not.be
			.reverted;
		await expect(
			htlc.connect(partyA).refundTokens(proposalIdA),
		).to.be.revertedWith("Tokens already refunded");
	});

	it("Should not allow a withdrawal twice", async function () {
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
		).not.to.be.reverted;

		await expect(
			htlc.connect(partyB).withdrawTokens(proposalIdA, bytes32EncodedSecret),
		).to.be.revertedWith("Tokens already claimed");
	});

	it("Should not allow the wrong party to refund", async function () {
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
			htlc.connect(partyB).refundTokens(proposalIdA),
		).to.be.revertedWith("Refunder is not partyA");
	});

	it("Should not allow a refund before the deadline", async function () {
		const currentBlock = await ethers.provider.getBlock("latest");
		const blockTime = currentBlock.timestamp;

		deadlineA = blockTime + 60 * 60 * 10;
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
			htlc.connect(partyA).refundTokens(proposalIdA),
		).to.be.revertedWith("Deadline not yet reached");
	});

	it("Should not allow partyA to claim its own lockup tokens", async function () {
		const currentBlock = await ethers.provider.getBlock("latest");
		const blockTime = currentBlock.timestamp;

		deadlineA = blockTime + 60 * 60 * 10;
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
			htlc.connect(partyA).withdrawTokens(proposalIdA, bytes32EncodedSecret),
		).to.be.revertedWith("Claimer is not partyB");
	});

	it("Should not allow the same HTLC instance to be created twice ", async function () {
		const currentBlock = await ethers.provider.getBlock("latest");
		const blockTime = currentBlock.timestamp;

		deadlineA = blockTime + 60 * 60 * 10;
		const secretSeed = "correct_secret";
		const bytes32EncodedSecret = ethers.utils.sha256(
			ethers.utils.toUtf8Bytes(secretSeed),
		);
		const secretHash = ethers.utils.sha256(bytes32EncodedSecret);

		await expect(
			htlc
				.connect(partyA)
				.createHTLCProposal({
					partyB: partyB.address,
					secretlock: secretHash,
					deadline: deadlineA,
					erc20Contract: tokenA.address,
					tokenAmount: ethers.utils.parseEther("25"),
					otherNetwork: "BTQ",
					otherAsset: "BTQ",
					otherAmount: ethers.utils.parseEther("1"),
				}),
		).not.to.be.reverted;

		await expect(
			htlc
				.connect(partyA)
				.createHTLCProposal({
					partyB: partyB.address,
					secretlock: secretHash,
					deadline: deadlineA,
					erc20Contract: tokenA.address,
					tokenAmount: ethers.utils.parseEther("25"),
					otherNetwork: "BTQ",
					otherAsset: "BTQ",
					otherAmount: ethers.utils.parseEther("1"),
				}),
		).to.be.revertedWith("Duplicate HTLC already exists");
	});
});
