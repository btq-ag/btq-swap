const { ethers } = require("hardhat");

const userEOAs = {
	Alice: "0x01735c575C171a060Be7Ec4aA30b409435Cdcd65",
	Bob: "0xd298F104d267524a3787E3d8793786AB1C562a6c",
};

async function main() {
	const Token = await ethers.getContractFactory("MockToken");
	const mockToken = await Token.deploy("MockToken", "MCK", 18);
	await mockToken.deployed();
	console.log(`Deployed Mock Token at ${mockToken.address}`);

	console.log(`------------------------------------------------------`);
	console.log(`Mock Token address: ${mockToken.address}`);
	console.log(`------------------------------------------------------`);

	let mintTx = await mockToken.mint(
		userEOAs.Bob,
		ethers.utils.parseEther("1000"),
	);
	await mintTx.wait();
	console.log(`Minted 1000 Mock tokens to Bob`);

	mintTx = await mockToken.mint(userEOAs.Alice, ethers.utils.parseEther("1000"));
	await mintTx.wait();
	console.log(`Minted 1000 Mock tokens to Alice`);
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
