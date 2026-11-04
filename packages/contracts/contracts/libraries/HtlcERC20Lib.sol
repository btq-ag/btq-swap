// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/interfaces/IERC20.sol";

library HtlcERC20Lib {
	struct HTLCProposal {
		address partyA;
		address partyB;
		bytes32 secretlock;
		uint32 deadline;
		uint tokenAmount;
		IERC20 erc20Contract;
		bool tokensWithdrawn;
		bool tokensRefunded;
		bytes32 key;
		string otherNetwork;
		string otherAsset;
		uint256 otherAmount;
	}

	event HTLCERC20Claimed(bytes32 indexed agreementId);

	event HTLCERC20Redeemed(bytes32 indexed agreementId);

	event HTLCERC20Lockup(
		bytes32 indexed agreementId,
		address indexed partyA,
		address indexed partyB,
		bytes32 secretlock,
		uint32 deadline,
		uint tokenAmount,
		IERC20 erc20Contract,
		string otherNetwork,
		string otherAsset,
		uint256 otherAmount
	);
}
