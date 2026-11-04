// SPDX-License-Identifier: MIT

pragma solidity ^0.8.20;

import "@openzeppelin/contracts/interfaces/IERC20.sol";
import "../libraries/HtlcERC20Lib.sol";

/**
 * @title BTQ Hashed Timelock Contract (HTLC) for ERC20 Tokens
 *
 * Facilitates trustless, decentralized, cryptographically secure cross-chain
 * atomic swaps of ERC20 tokens. Allows exchange of ERC20 tokens between
 * BTQ and other EVM chains or Bitcoin.
 *
 * Uses a Secure Exchange Protocol (SEP) leveraging one-way SHA-256 hashing
 * of cryptographic secrets and time-constrained actions to ensure safety
 * and atomicity of cross-chain swaps.
 */

contract HtlcERC20 {
	using HtlcERC20Lib for HtlcERC20Lib.HTLCProposal;

	mapping(bytes32 => HtlcERC20Lib.HTLCProposal) htlcInstances;

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

	modifier HTLCInstanceExists(bytes32 _htlcInstanceId) {
		require(
			alreadyExistsHTLCInstance(_htlcInstanceId),
			"agreementId does not exist"
		);
		_;
	}

	modifier tokenAmountGTZero(
		IERC20 _token,
		address _partyA,
		uint _tokenAmount
	) {
		require(_tokenAmount > 0, "Locked amount must be GT 0");
		require(
			_token.allowance(_partyA, address(this)) >= _tokenAmount,
			"Allowance must be GTE amount"
		);
		_;
	}

	/**
	 * The onus is on the proposer to ensure that a reasonable deadline has been selected. Obviously it is not useful to have a deadline
	 * that is shorter than the average time of a block. The proposer should also consider the time it takes to execute the swap on the
	 * other chain plus a reasonable number of confirmations to avoid orphaned blocked. For example, if the proposer is swapping tokens
	 * on BTQ for tokens on Ethereum, they should consider the time it takes to execute the swap on Ethereum.
	 * It could be useful to take an opinionated approach to this and set a minimum deadline on a front-end that is powering this system,
	 * but for simplicity we leave it up to the proposer to decide.
	 */

	modifier deadlineGTNow(uint32 _deadline) {
		require(_deadline > block.timestamp, "deadline time must be in the future");
		_;
	}

	modifier assetsRefundable(bytes32 _htlcInstanceId) {
		require(
			!htlcInstances[_htlcInstanceId].tokensRefunded,
			"Tokens already refunded"
		);
		require(
			!htlcInstances[_htlcInstanceId].tokensWithdrawn,
			"Tokens already withdrawn"
		);
		require(
			htlcInstances[_htlcInstanceId].partyA == msg.sender,
			"Refunder is not partyA"
		);
		require(
			htlcInstances[_htlcInstanceId].deadline <= block.timestamp,
			"Deadline not yet reached"
		);
		_;
	}

	modifier assetsClaimable(bytes32 _htlcInstanceId) {
		require(
			htlcInstances[_htlcInstanceId].partyB == msg.sender,
			"Claimer is not partyB"
		);
		require(
			!htlcInstances[_htlcInstanceId].tokensWithdrawn,
			"Tokens already claimed"
		);
		require(
			!htlcInstances[_htlcInstanceId].tokensRefunded,
			"Tokens already refunded"
		);
		require(
			htlcInstances[_htlcInstanceId].deadline > block.timestamp,
			"Timelock must be in the future"
		);
		_;
	}

	modifier keyOpensLock(bytes32 _htlcInstanceId, bytes32 _x) {
		require(
			htlcInstances[_htlcInstanceId].secretlock == sha256(abi.encodePacked(_x)),
			"secretlock hash does not match"
		);
		_;
	}

	/**
     * @dev The proposer partyA sets up a new HTLC and locks their asset inside it
     *
     * _partyB must have already approved the contract to use their tokens.
     *
     * _partyB The counter party and receiver of partyA's tokens.
     * _secretlock a SHA2 hash of the secret, which partyA may choose.
     * _deadline The UNIX time int after which partyA may claim a refund.
     * _erc20Contract The actual aToken or ERC20 contract.
     * _tokenAmount The number of tokens or ERC20 to lock into the contract.
	 * _otherNetwork The network where the other party is
	 * _otherAsset The asset the other party is sending
	 * _otherAmount The amount of the other asset
     * @return agreementId Unique id representing the HTLC.
     */
	function createHTLCProposal(HTLCParams calldata params)
		external
		tokenAmountGTZero(params.erc20Contract, msg.sender, params.tokenAmount)
		deadlineGTNow(params.deadline)
		returns (bytes32 agreementId)
	{
		agreementId = sha256(
			abi.encodePacked(
				msg.sender,
				params.partyB,
				params.erc20Contract,
				params.tokenAmount,
				params.secretlock,
				params.deadline,
				params.otherNetwork,
				params.otherAsset,
				params.otherAmount
			)
		);

		if (alreadyExistsHTLCInstance(agreementId)) {
			revert("Duplicate HTLC already exists");
		}

		if (
			!params.erc20Contract.transferFrom(msg.sender, address(this), params.tokenAmount)
		) {
			revert("transferFrom from partyA failed");
		}

		htlcInstances[agreementId] = HtlcERC20Lib.HTLCProposal(
			msg.sender,
			params.partyB,
			params.secretlock,
			params.deadline,
			params.tokenAmount,
			params.erc20Contract,
			false,
			false,
			0,
			params.otherNetwork,
			params.otherAsset,
			params.otherAmount
		);

		emit HtlcERC20Lib.HTLCERC20Lockup(
			agreementId,
			msg.sender,
			params.partyB,
			params.secretlock,
			params.deadline,
			params.tokenAmount,
			params.erc20Contract,
			params.otherNetwork,
			params.otherAsset,
			params.otherAmount
		);
	}

	/**
	 * @dev PartyB claims the tokens locked by PartyA by providing the secret
	 * that was used in the contract creation. This is only possible if PartyA has revealed
	 * the secret to PartyB by claiming PartyB's funds
	 *
	 * @param _htlcInstanceId The unique identifier for this HTLC instance.
	 * @param _key to be checked against lock using sha256.
	 * @return bool return true if everything worked as expected
	 */

	function withdrawTokens(
		bytes32 _htlcInstanceId,
		bytes32 _key
	)
		external
		HTLCInstanceExists(_htlcInstanceId)
		keyOpensLock(_htlcInstanceId, _key)
		assetsClaimable(_htlcInstanceId)
		returns (bool)
	{
		HtlcERC20Lib.HTLCProposal storage instance = htlcInstances[_htlcInstanceId];

		instance.key = _key;

		instance.tokensWithdrawn = true;
		IERC20(instance.erc20Contract).transfer(instance.partyB, instance.tokenAmount);
		emit HtlcERC20Lib.HTLCERC20Claimed(_htlcInstanceId);
		return true;
	}

	/**
	 * @dev Called by the partyA if there was no withdraw AND the time lock has
	 * expired. This will restore ownership of the tokens to the partyA.
	 *
	 * @param _htlcInstanceId Id of HTLC to refund from.
	 * @return bool true on success
	 */
	function refundTokens(
		bytes32 _htlcInstanceId
	)
		external
		HTLCInstanceExists(_htlcInstanceId)
		assetsRefundable(_htlcInstanceId)
		returns (bool)
	{
		HtlcERC20Lib.HTLCProposal storage instance = htlcInstances[_htlcInstanceId];
		instance.tokensRefunded = true;
		IERC20(instance.erc20Contract).transfer(instance.partyA, instance.tokenAmount);
		emit HtlcERC20Lib.HTLCERC20Redeemed(_htlcInstanceId);
		return true;
	}

	/**
	 * @dev Get contract details.
	 * @param _htlcInstanceId HTLC contract id
	 */
	function getHTLCInstance(
		bytes32 _htlcInstanceId
	)
		public
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
		)
	{
		if (alreadyExistsHTLCInstance(_htlcInstanceId) == false) {
			return (address(0x0), address(0x0), IERC20(address(0x0)), 0, 0, 0, true, true, 0, "", "", 0);
		}
		HtlcERC20Lib.HTLCProposal storage instance = htlcInstances[_htlcInstanceId];
		return (
			instance.partyA,
			instance.partyB,
			instance.erc20Contract,
			instance.tokenAmount,
			instance.secretlock,
			instance.deadline,
			instance.tokensWithdrawn,
			instance.tokensRefunded,
			instance.key,
			instance.otherNetwork,
			instance.otherAsset,
			instance.otherAmount
		);
	}

	/**
	 * @dev Is there a contract with id _htlcInstanceId.
	 * @param _htlcInstanceId Id into htlcInstances mapping.
	 */
	function alreadyExistsHTLCInstance(
		bytes32 _htlcInstanceId
	) internal view returns (bool doesExist) {
		doesExist = (htlcInstances[_htlcInstanceId].partyA != address(0));
	}
}
