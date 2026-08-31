// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

contract TestERC20 {
    mapping(address account => uint256 amount) public balanceOf;

    event Transfer(address indexed from, address indexed to, uint256 value);

    function mint(address recipient, uint256 amount) external {
        balanceOf[recipient] += amount;
        emit Transfer(address(0), recipient, amount);
    }

    function transfer(address recipient, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[recipient] += amount;
        emit Transfer(msg.sender, recipient, amount);
        return true;
    }
}
