// SPDX-License-Identifier: MIT

pragma solidity ^0.8.20;

import "@openzeppelin/contracts/interfaces/IERC20.sol";

/**
 * @title BTQ HTLC for ERC20 Tokens — Interface
 */

interface IHtlcERC20 {
	struct HTLCParams {
		address partyB;
		bytes32 secretlock;
		uint32 deadline;
		IERC20 erc20Contract;
		uint tokenAmount;
		string otherNetwork;
		string otherAsset;
		uint256 otherAmount;
	}

	function createHTLCProposal(
		HTLCParams calldata params
	) external returns (bytes32 agreementId);

	function withdrawTokens(
		bytes32 _htlcInstanceId,
		bytes32 _key
	) external returns (bool);

	function refundTokens(bytes32 _htlcInstanceId) external returns (bool);

	function getHTLCInstance(
		bytes32 _htlcInstanceId
	)
		external
		view
		returns (
			address partyA,
			address partyB,
			IERC20 erc20Contract,
			uint tokenAmount,
			bytes32 secretlock,
			uint32 deadline,
			bool tokensWithdrawn,
			bool tokensRefunded,
			bytes32 key,
			string memory otherNetwork,
			string memory otherAsset,
			uint256 otherAmount
		);
}
