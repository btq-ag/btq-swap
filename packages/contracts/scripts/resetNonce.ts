async function main() {
  console.log("Starting");

  const privateKey = process.env.PK;
  
  if (!privateKey) {
    throw new Error("Please set your PK in a .env file");
  }

  const wallet = new ethers.Wallet(privateKey);
  const provider = ethers.provider;
  const signer = wallet.connect(provider);
  const myAddress = await signer.getAddress();

  console.log(`Sending 0 ETH to ${myAddress} from ${myAddress}`);

  const nonce = await provider.getTransactionCount(myAddress);
  console.log(`Using nonce: ${nonce}`);

  const tx = await signer.sendTransaction({
    to: myAddress,
    value: ethers.utils.parseEther("0"),
    nonce: nonce
  });

  const receipt = await tx.wait();
  console.log(`Transaction successful with hash: ${receipt.transactionHash}`);
}

main();
