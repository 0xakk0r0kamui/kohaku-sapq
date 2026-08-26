// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract MockAnnouncer {
    event Announcement(
        uint256 indexed schemeId,
        address indexed stealthAddress,
        address indexed caller,
        bytes ephemeralPubKey,
        bytes metadata
    );

    function announce(
        uint256 schemeId,
        address stealthAddress,
        bytes calldata ephemeralPubKey,
        bytes calldata metadata
    ) external {
        emit Announcement(schemeId, stealthAddress, msg.sender, ephemeralPubKey, metadata);
    }
}

contract MockRegistry {
    mapping(address registrant => mapping(uint256 schemeId => bytes metaAddress)) private records;

    function registerKeys(uint256 schemeId, bytes calldata stealthMetaAddress) external {
        records[msg.sender][schemeId] = stealthMetaAddress;
    }

    function stealthMetaAddressOf(address registrant, uint256 schemeId)
        external
        view
        returns (bytes memory)
    {
        return records[registrant][schemeId];
    }
}

contract MockERC20 {
    mapping(address account => uint256 amount) public balanceOf;
    event Transfer(address indexed from, address indexed to, uint256 value);

    function mint(address to, uint256 value) external {
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        require(balanceOf[msg.sender] >= value, "balance");
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        emit Transfer(msg.sender, to, value);
        return true;
    }
}

contract MockERC721 {
    mapping(uint256 tokenId => address owner) public ownerOf;
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);

    function mint(address to, uint256 tokenId) external {
        require(ownerOf[tokenId] == address(0), "minted");
        ownerOf[tokenId] = to;
        emit Transfer(address(0), to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        require(msg.sender == from && ownerOf[tokenId] == from, "owner");
        ownerOf[tokenId] = to;
        emit Transfer(from, to, tokenId);
    }
}
