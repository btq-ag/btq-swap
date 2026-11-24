// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * Mainnet USDT-shaped ERC-20: transfer and transferFrom return no data.
 * A boolean IERC20.transfer / transferFrom call reverts against this token.
 */
contract TetherStyleUSDT {
	string public name = "Tether USD";
	string public symbol = "USDT";
	uint8 public decimals = 6;

	uint256 public totalSupply;
	mapping(address => uint256) public balanceOf;
	mapping(address => mapping(address => uint256)) public allowance;

	function mint(address to, uint256 amount) external {
		balanceOf[to] += amount;
		totalSupply += amount;
	}

	function approve(address spender, uint256 amount) external returns (bool) {
		allowance[msg.sender][spender] = amount;
		return true;
	}

	function transfer(address to, uint256 amount) external {
		_move(msg.sender, to, amount);
	}

	function transferFrom(address from, address to, uint256 amount) external {
		uint256 allowed = allowance[from][msg.sender];
		require(allowed >= amount, "allowance");
		allowance[from][msg.sender] = allowed - amount;
		_move(from, to, amount);
	}

	function _move(address from, address to, uint256 amount) internal {
		require(balanceOf[from] >= amount, "balance");
		balanceOf[from] -= amount;
		balanceOf[to] += amount;
	}
}
