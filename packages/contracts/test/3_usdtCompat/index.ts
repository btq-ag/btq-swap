import { ethers } from "hardhat";
import { expect } from "chai";
import { HtlcERC20, TetherStyleUSDT } from "../../typechain";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";

describe("HtlcERC20 with a USDT-style token that returns no data", function () {
	let token: TetherStyleUSDT;
	let htlc: HtlcERC20;
	let partyA: SignerWithAddress;
	let partyB: SignerWithAddress;
	const amount = 1_000_000; // 1 USDT, 6 decimals

	async function lock(): Promise<{ agreementId: string; secret: string }> {
		const secret = ethers.utils.sha256(ethers.utils.toUtf8Bytes("btq-usdt"));
		const secretlock = ethers.utils.sha256(secret);
		const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
		const tx = await htlc.connect(partyA).createHTLCProposal({
			partyB: partyB.address,
			secretlock,
			deadline,
			erc20Contract: token.address,
			tokenAmount: amount,
			otherNetwork: "BTQ",
			otherAsset: "BTQ",
			otherAmount: ethers.utils.parseEther("1"),
		});
		const receipt = await tx.wait();
		const event = receipt.events?.find((e) => e.event === "HTLCERC20Lockup");
		return { agreementId: event!.args!.agreementId, secret };
	}

	beforeEach(async function () {
		[partyA, partyB] = await ethers.getSigners();
		token = await (await ethers.getContractFactory("TetherStyleUSDT")).deploy();
		await token.deployed();
		htlc = await (await ethers.getContractFactory("HtlcERC20")).deploy();
		await htlc.deployed();
		await token.mint(partyA.address, amount * 2);
		await token.connect(partyA).approve(htlc.address, amount * 2);
	});

	it("locks, then lets partyB claim", async function () {
		const { agreementId, secret } = await lock();
		expect(await token.balanceOf(htlc.address)).to.equal(amount);
		await expect(htlc.connect(partyB).withdrawTokens(agreementId, secret)).to.not.be.reverted;
		expect(await token.balanceOf(partyB.address)).to.equal(amount);
		expect(await token.balanceOf(htlc.address)).to.equal(0);
	});

	it("locks, then lets partyA refund after the deadline", async function () {
		const { agreementId } = await lock();
		await ethers.provider.send("evm_increaseTime", [3601]);
		await ethers.provider.send("evm_mine", []);
		await expect(htlc.connect(partyA).refundTokens(agreementId)).to.not.be.reverted;
		expect(await token.balanceOf(partyA.address)).to.equal(amount * 2);
		expect(await token.balanceOf(htlc.address)).to.equal(0);
	});
});
