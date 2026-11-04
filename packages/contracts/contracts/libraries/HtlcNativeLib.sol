// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

library HtlcNativeLib {
	struct HTLCProposal {
		address payable partyA;
		address payable partyB;
		uint amount;
		bytes32 secretLock;
		uint deadline;
		bool tokensWithdrawn;
		bool tokensRefunded;
		bytes32 key;
		string otherNetwork;
		string otherAsset;
		uint256 otherAmount;
	}

	event HTLCNativeLockup(
		bytes32 indexed agreementId,
		address indexed partyA,
		address indexed partyB,
		uint tokenAmount,
		bytes32 secretlock,
		uint32 deadline,
		string otherNetwork,
		string otherAsset,
		uint256 otherAmount
	);

	event HTLCNativeClaimed(bytes32 indexed contractId);
	event HTLCNativeRedeemed(bytes32 indexed contractId);
}
