// SPDX-License-Identifier: MIT

pragma solidity ^0.8.20;

import "../libraries/HtlcNativeLib.sol";

/**
 * @title BTQ Hashed Timelock Contract (HTLC) for Native Assets
 *
 * Facilitates trustless, decentralized, cryptographically secure cross-chain
 * atomic swaps of native assets. Allows exchange of native assets between
 * BTQ and other EVM chains or Bitcoin.
 *
 * Uses a Secure Exchange Protocol (SEP) leveraging one-way SHA-256 hashing
 * of cryptographic secrets and time-constrained actions to ensure safety
 * and atomicity of cross-chain swaps.
 */

contract HtlcNative {
	using HtlcNativeLib for HtlcNativeLib.HTLCProposal;

	mapping(bytes32 => HtlcNativeLib.HTLCProposal) htlcInstances;

	modifier paidFor() {
		require(msg.value > 0, "htlc value must be gt 0");
		_;
	}
	modifier deadlineGTNow(uint _deadline) {
		require(_deadline > block.timestamp, "deadline time must be in the future");
		_;
	}
	modifier HTLCInstanceExists(bytes32 _htlcInstanceId) {
		require(alreadyExistsHTLCInstance(_htlcInstanceId), "contractId does not exist");
		_;
	}
	modifier keyOpensLock(bytes32 _htlcInstanceId, bytes32 _x) {
		require(
			htlcInstances[_htlcInstanceId].secretLock == sha256(abi.encodePacked(_x)),
			"secretLock hash does not match"
		);
		_;
	}
	modifier assetsRefundable(bytes32 _htlcInstanceId) {
		require(htlcInstances[_htlcInstanceId].tokensRefunded == false, "Tokens already refunded");
		require(
			htlcInstances[_htlcInstanceId].tokensWithdrawn == false,
			"Tokens already tokensWithdrawn"
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
		require(htlcInstances[_htlcInstanceId].partyB == msg.sender, "Claimer is not partyB");
		require(htlcInstances[_htlcInstanceId].tokensWithdrawn == false, "Tokens already claimed");
		require(htlcInstances[_htlcInstanceId].tokensRefunded == false, "Tokens already refunded");
		require(
			htlcInstances[_htlcInstanceId].deadline > block.timestamp,
			"deadline must be in the future"
		);
		_;
	}

	/**
	 * @dev Sender sets up a new hash time lock contract depositing the native
	 * asset and providing the receiver lock terms.
	 *
	 * @param _partyB Receiver of the native asset.
	 * @param _secretLock A sha-2 sha256 hash secretLock.
	 * @param _deadline UNIX epoch seconds time that the lock expires at.
	 *                  Refunds can be made after this time.
	 * @param _otherNetwork The network the partyB is on.
	 * @param _otherAsset The asset the partyB is receiving.
	 * @param _otherAmount The amount of the asset the partyB is receiving.
	 * @return contractId Id of the new HTLC. This is needed for subsequent calls.
	 */
	function createHTLCProposal(
		address payable _partyB,
		bytes32 _secretLock,
		uint32 _deadline,
		string calldata _otherNetwork,
		string calldata _otherAsset,
		uint256 _otherAmount
	)
		external
		payable
		paidFor
		deadlineGTNow(_deadline)
		returns (bytes32 contractId)
	{
		contractId = sha256(
			abi.encodePacked(msg.sender, _partyB, msg.value, _secretLock, _deadline, _otherNetwork, _otherAsset, _otherAmount)
		);

		if (alreadyExistsHTLCInstance(contractId)) revert("Duplicate HTLC already exists");

		htlcInstances[contractId] = HtlcNativeLib.HTLCProposal(
			payable(msg.sender),
			_partyB,
			msg.value,
			_secretLock,
			_deadline,
			false,
			false,
			0x0,
			_otherNetwork,
			_otherAsset,
			_otherAmount
		);

		emit HtlcNativeLib.HTLCNativeLockup(
			contractId,
			msg.sender,
			_partyB,
			msg.value,
			_secretLock,
			_deadline,
			_otherNetwork,
			_otherAsset,
			_otherAmount
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
	function withdraw(
		bytes32 _htlcInstanceId,
		bytes32 _key
	)
		external
		HTLCInstanceExists(_htlcInstanceId)
		keyOpensLock(_htlcInstanceId, _key)
		assetsClaimable(_htlcInstanceId)
		returns (bool)
	{
		HtlcNativeLib.HTLCProposal storage c = htlcInstances[_htlcInstanceId];
		
        c.key = _key;
		
        c.tokensWithdrawn = true;

		c.partyB.transfer(c.amount);
		emit HtlcNativeLib.HTLCNativeClaimed(_htlcInstanceId);
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
		HtlcNativeLib.HTLCProposal storage c = htlcInstances[_htlcInstanceId];
		c.tokensRefunded = true;
		c.partyA.transfer(c.amount);
		emit HtlcNativeLib.HTLCNativeRedeemed(_htlcInstanceId);
		return true;
	}

	/**
	 * @dev Get contract details.
	 * @param _htlcInstanceId HTLC contract id
	 */
	function getContract(
		bytes32 _htlcInstanceId
	)
		public
		view
		returns (
			address partyA,
			address partyB,
			uint amount,
			bytes32 secretLock,
			uint deadline,
			bool tokensWithdrawn,
			bool tokensRefunded,
			bytes32 key,
			string memory otherNetwork,
			string memory otherAsset,
			uint256 otherAmount
		)
	{
		if (alreadyExistsHTLCInstance(_htlcInstanceId) == false)
			return (address(0), address(0), 0, 0, 0, false, false, 0, "", "", 0);
		HtlcNativeLib.HTLCProposal storage c = htlcInstances[_htlcInstanceId];
		return (
			c.partyA,
			c.partyB,
			c.amount,
			c.secretLock,
			c.deadline,
			c.tokensWithdrawn,
			c.tokensRefunded,
			c.key,
			c.otherNetwork,
			c.otherAsset,
			c.otherAmount
		);
	}

	/**
	 * @dev Is there a contract with id _htlcInstanceId.
	 * @param _htlcInstanceId Id into htlcInstances mapping.
	 */
	function alreadyExistsHTLCInstance(
		bytes32 _htlcInstanceId
	) internal view returns (bool exists) {
		exists = (htlcInstances[_htlcInstanceId].partyA != address(0));
	}
}
