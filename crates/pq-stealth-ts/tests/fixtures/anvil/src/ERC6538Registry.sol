// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

contract ERC6538Registry {
    mapping(address registrant => mapping(uint256 schemeId => bytes keys)) private entries;

    function registerKeys(uint256 schemeId, bytes calldata stealthMetaAddress) external {
        entries[msg.sender][schemeId] = stealthMetaAddress;
    }

    function stealthMetaAddressOf(address registrant, uint256 schemeId)
        external
        view
        returns (bytes memory)
    {
        return entries[registrant][schemeId];
    }
}
