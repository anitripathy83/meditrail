// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title  MediTrail - proof-carrying custody for temperature-sensitive medicine
/// @notice A health regulator (admin) approves companies and sensors, each with a licence end date.
///         A box moves manufacturer -> distributor -> pharmacy -> customer.
///         Every handover is two-sided: the holder OFFERS the box to a named company and stores the
///         fingerprint (keccak256) of a one-time seal code packed inside the tamper seal; the receiver
///         ACCEPTS by revealing that code, which proves it physically holds the box.
///         A registered sensor signs temperature readings; any reading outside 2.0-8.0 C locks the box.
///         Nothing is ever edited or deleted: corrections, rejections and recalls are new entries.
/// @dev    Demo only. Fictional companies and IDs, no personal data. Only fingerprints of documents.
contract MediTrail {
    // ------------------------------------------------------------------
    // Types
    // ------------------------------------------------------------------

    enum Role { None, Manufacturer, Distributor, Pharmacy, Sensor }

    /// The only order allowed. "To..." means a handover is waiting for the receiver to accept.
    enum Stage { None, Manufactured, ToDistributor, WithDistributor, ToPharmacy, AtPharmacy, Sold }

    /// One answer for the public check page, worked out by the contract itself.
    enum Verdict { Unknown, InSupplyChain, ReadyAtPharmacy, Sold, Compromised, Recalled, Expired }

    struct Member {
        Role role;
        string name;
        uint64 licenceUntil; // unix time; steps after this are refused
    }

    struct Box {
        string id;            // printed on the box and in its QR code, e.g. "INS-0001"
        string medicine;      // e.g. "Insulin glargine 100 U/ml (demo)"
        string batch;         // e.g. "B-2611"
        uint64 expiry;        // unix time; the contract refuses to sell after this
        Stage stage;
        address manufacturer;
        address holder;       // the one accountable company right now
        address pendingTo;    // the company a handover is offered to (0 if none)
        bytes32 sealHash;     // keccak256 of the current one-time seal code
        address sensor;       // the only key whose temperature readings are accepted
        bytes32 certHash;     // keccak256 fingerprint of the batch certificate PDF
        bool compromised;     // set forever by an out-of-range signed reading
        int16 minTemp;        // tenths of a degree C, e.g. 54 = 5.4 C
        int16 maxTemp;
        uint32 readingCount;
        uint64 lastReadingAt;
        uint64 createdAt;
    }

    struct Entry {
        string kind;     // Registered, Offered, Received, Rejected, Temperature breach, Sold, Recalled, Correction
        string note;     // free text, never personal data
        Stage stage;     // stage after this entry
        address by;      // the wallet that signed it
        Role role;       // that wallet's role at the time
        uint64 time;
        uint64 blockNo;  // lets the website find this step's transaction
    }

    struct Reading {
        int16 temp;      // tenths of a degree C
        uint64 takenAt;  // time the sensor signed
        address relayedBy;
    }

    struct RecallInfo {
        bool recalled;
        string reason;
        address by;
        uint64 time;
    }

    // ------------------------------------------------------------------
    // Constants and storage
    // ------------------------------------------------------------------

    int16 public constant MIN_SAFE_TEMP = 20; // 2.0 C
    int16 public constant MAX_SAFE_TEMP = 80; // 8.0 C

    address public admin;

    mapping(address => Member) private memberOf;
    address[] private memberList;
    mapping(address => bool) private listed;

    mapping(bytes32 => Box) private boxes;
    mapping(bytes32 => Entry[]) private history;
    mapping(bytes32 => Reading[]) private readings;
    mapping(bytes32 => mapping(address => bool)) private handled;
    string[] private boxIds;

    mapping(bytes32 => RecallInfo) private recalls;     // batch key -> recall
    mapping(bytes32 => address) private batchMaker;    // batch key -> manufacturer
    mapping(bytes32 => bytes32[]) private batchBoxes;  // batch key -> box keys

    // ------------------------------------------------------------------
    // Events (visible on the block explorer)
    // ------------------------------------------------------------------

    event MemberSet(address indexed wallet, Role role, string name, uint64 licenceUntil);
    event Step(bytes32 indexed boxKey, string boxId, string kind, address indexed by);
    event ReadingAdded(bytes32 indexed boxKey, int16 temp, uint64 takenAt, bool breach);
    event BatchRecalled(bytes32 indexed batchKey, string batch, string reason, address indexed by);

    constructor() {
        admin = msg.sender;
    }

    // ------------------------------------------------------------------
    // Regulator (admin)
    // ------------------------------------------------------------------

    /// @notice Approve a company or sensor with a licence end date, or remove it with role None (0).
    function setMember(address wallet, Role role, string calldata name, uint64 licenceUntil) external {
        require(msg.sender == admin, "Only the regulator can approve companies");
        require(wallet != address(0), "Enter a valid wallet address");
        if (role != Role.None) {
            require(bytes(name).length > 0, "Enter the company or sensor name");
            require(licenceUntil > block.timestamp, "The licence end date must be in the future");
        }
        memberOf[wallet] = Member(role, name, licenceUntil);
        if (!listed[wallet]) {
            listed[wallet] = true;
            memberList.push(wallet);
        }
        emit MemberSet(wallet, role, name, licenceUntil);
    }

    // ------------------------------------------------------------------
    // Manufacturer
    // ------------------------------------------------------------------

    /// @notice Register a new box with its attached sensor and certificate fingerprint.
    function registerBox(
        string calldata id,
        string calldata medicine,
        string calldata batch,
        uint64 expiry,
        address sensor,
        bytes32 certHash
    ) external {
        _requireActive(msg.sender, Role.Manufacturer, "Only an approved manufacturer can register a box");
        require(bytes(id).length > 0 && bytes(id).length <= 64, "Enter a box ID (up to 64 characters)");
        require(bytes(batch).length > 0, "Enter the batch number");
        bytes32 key = _key(id);
        require(boxes[key].stage == Stage.None, "This box ID already exists");
        require(expiry > block.timestamp, "The expiry date must be in the future");
        require(
            memberOf[sensor].role == Role.Sensor && memberOf[sensor].licenceUntil >= block.timestamp,
            "Attach a sensor the regulator has approved"
        );
        bytes32 bKey = _key(batch);
        require(!recalls[bKey].recalled, "This batch has been recalled");
        if (batchMaker[bKey] == address(0)) {
            batchMaker[bKey] = msg.sender;
        } else {
            require(batchMaker[bKey] == msg.sender, "This batch number belongs to another manufacturer");
        }

        Box storage b = boxes[key];
        b.id = id;
        b.medicine = medicine;
        b.batch = batch;
        b.expiry = expiry;
        b.stage = Stage.Manufactured;
        b.manufacturer = msg.sender;
        b.holder = msg.sender;
        b.sensor = sensor;
        b.certHash = certHash;
        b.createdAt = uint64(block.timestamp);

        boxIds.push(id);
        batchBoxes[bKey].push(key);
        _record(key, "Registered", "", Stage.Manufactured);
    }

    // ------------------------------------------------------------------
    // Two-sided handover
    // ------------------------------------------------------------------

    /// @notice The holder offers the box to the next company and stores the seal code's fingerprint.
    function offer(string calldata id, address to, bytes32 sealHash, string calldata note) external {
        (bytes32 key, Box storage b) = _load(id);
        require(b.holder == msg.sender, "Only the company holding this box can hand it over");
        _requireActive(msg.sender, memberOf[msg.sender].role, "Your licence has expired");
        _requireMovable(b);
        require(b.pendingTo == address(0), "This box already has a handover waiting");
        require(sealHash != bytes32(0), "Create a seal code first");

        Stage next;
        if (b.stage == Stage.Manufactured) {
            require(memberOf[to].role == Role.Distributor, "Out of order: a box must go to a distributor next");
            next = Stage.ToDistributor;
        } else if (b.stage == Stage.WithDistributor) {
            require(memberOf[to].role == Role.Pharmacy, "Out of order: a box must go to a pharmacy next");
            next = Stage.ToPharmacy;
        } else {
            revert("This box is at the pharmacy: it can only be sold now");
        }
        require(memberOf[to].licenceUntil >= block.timestamp, "The receiving company's licence has expired");

        b.pendingTo = to;
        b.sealHash = sealHash;
        b.stage = next;
        _record(key, "Offered", note, next);
    }

    /// @notice The named receiver takes custody by typing the seal code found inside the tamper seal.
    function accept(string calldata id, string calldata sealCode) external {
        (bytes32 key, Box storage b) = _load(id);
        require(b.pendingTo != address(0) && b.pendingTo == msg.sender, "This box was not offered to you");
        _requireActive(msg.sender, memberOf[msg.sender].role, "Your licence has expired");
        _requireMovable(b);
        require(keccak256(bytes(sealCode)) == b.sealHash, "Seal code does not match");

        Stage next = b.stage == Stage.ToDistributor ? Stage.WithDistributor : Stage.AtPharmacy;
        b.holder = msg.sender;
        b.pendingTo = address(0);
        b.sealHash = bytes32(0);
        b.stage = next;
        _record(key, "Received", "Seal code verified", next);
    }

    /// @notice The named receiver refuses a delivery (for example a broken seal). The sender keeps custody.
    function reject(string calldata id, string calldata reason) external {
        (bytes32 key, Box storage b) = _load(id);
        require(b.pendingTo != address(0) && b.pendingTo == msg.sender, "This box was not offered to you");
        require(bytes(reason).length > 0, "Write why you are rejecting the box");
        Stage back = b.stage == Stage.ToDistributor ? Stage.Manufactured : Stage.WithDistributor;
        b.pendingTo = address(0);
        b.sealHash = bytes32(0);
        b.stage = back;
        _record(key, "Rejected", reason, back);
    }

    // ------------------------------------------------------------------
    // Sensor-signed temperatures
    // ------------------------------------------------------------------

    /// @notice Store a temperature reading. Anyone may relay it, but only the box's sensor can sign it.
    /// @param temp     tenths of a degree C (54 = 5.4 C)
    /// @param takenAt  unix time the sensor took the reading
    /// @param signature the sensor's signature over readingDigest(id, temp, takenAt)
    function submitReading(string calldata id, int16 temp, uint64 takenAt, bytes calldata signature) external {
        (bytes32 key, Box storage b) = _load(id);
        require(b.stage != Stage.Sold, "This box was already sold");
        require(takenAt > b.lastReadingAt, "Reading is out of date");
        require(takenAt <= block.timestamp + 300, "Reading time is in the future");
        address signer = _recover(readingDigest(id, temp, takenAt), signature);
        require(signer == b.sensor, "Reading not signed by this box's sensor");
        require(memberOf[signer].licenceUntil >= block.timestamp, "This sensor's approval has expired");

        if (b.readingCount == 0) {
            b.minTemp = temp;
            b.maxTemp = temp;
        } else {
            if (temp < b.minTemp) b.minTemp = temp;
            if (temp > b.maxTemp) b.maxTemp = temp;
        }
        b.readingCount += 1;
        b.lastReadingAt = takenAt;
        readings[key].push(Reading(temp, takenAt, msg.sender));

        bool breach = temp < MIN_SAFE_TEMP || temp > MAX_SAFE_TEMP;
        emit ReadingAdded(key, temp, takenAt, breach);
        if (breach && !b.compromised) {
            b.compromised = true;
            _record(key, "Temperature breach", _tempNote(temp), b.stage);
        }
    }

    /// @notice The exact message a sensor signs (with the standard "Ethereum Signed Message" prefix).
    function readingDigest(string calldata id, int16 temp, uint64 takenAt) public view returns (bytes32) {
        bytes32 inner = keccak256(abi.encodePacked(address(this), _key(id), temp, takenAt));
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", inner));
    }

    /// @notice The inner hash a sensor signs; the website signs these 32 bytes as a message.
    function readingHash(string calldata id, int16 temp, uint64 takenAt) external view returns (bytes32) {
        return keccak256(abi.encodePacked(address(this), _key(id), temp, takenAt));
    }

    // ------------------------------------------------------------------
    // Pharmacy
    // ------------------------------------------------------------------

    /// @notice The pharmacy holding the box sells it, once. No customer data is stored.
    function sell(string calldata id) external {
        (bytes32 key, Box storage b) = _load(id);
        require(b.stage != Stage.Sold, "This box was already sold");
        require(b.holder == msg.sender && b.stage == Stage.AtPharmacy, "Only the pharmacy holding this box can sell it");
        _requireActive(msg.sender, Role.Pharmacy, "Your licence has expired");
        _requireMovable(b);
        require(block.timestamp <= b.expiry, "This box has expired and cannot be sold");
        b.stage = Stage.Sold;
        _record(key, "Sold", "", Stage.Sold);
    }

    // ------------------------------------------------------------------
    // Recalls and corrections
    // ------------------------------------------------------------------

    /// @notice Recall every box in a batch in one transaction.
    function recallBatch(string calldata batch, string calldata reason) external {
        bytes32 bKey = _key(batch);
        address maker = batchMaker[bKey];
        require(maker != address(0), "No boxes exist in this batch");
        require(msg.sender == admin || msg.sender == maker, "Only the regulator or this batch's manufacturer can recall it");
        require(!recalls[bKey].recalled, "This batch is already recalled");
        require(bytes(reason).length > 0, "Write the reason for the recall");
        recalls[bKey] = RecallInfo(true, reason, msg.sender, uint64(block.timestamp));
        bytes32[] storage keys = batchBoxes[bKey];
        for (uint256 i = 0; i < keys.length; i++) {
            _record(keys[i], "Recalled", reason, boxes[keys[i]].stage);
        }
        emit BatchRecalled(bKey, batch, reason, msg.sender);
    }

    /// @notice Fix a mistake by adding a new entry. The old entry stays.
    function addCorrection(string calldata id, string calldata note) external {
        bytes32 key = _key(id);
        require(boxes[key].stage != Stage.None, "No box with this ID exists");
        require(handled[key][msg.sender] || msg.sender == admin, "Only a company that handled this box can add a correction");
        require(bytes(note).length > 0, "Write what the correction is");
        _record(key, "Correction", note, boxes[key].stage);
    }

    // ------------------------------------------------------------------
    // Public reads: free, no wallet needed
    // ------------------------------------------------------------------

    function getBox(string calldata id) external view returns (Box memory) {
        return boxes[_key(id)];
    }

    function getHistory(string calldata id) external view returns (Entry[] memory) {
        return history[_key(id)];
    }

    function getReadings(string calldata id) external view returns (Reading[] memory) {
        return readings[_key(id)];
    }

    function getRecall(string calldata batch) external view returns (RecallInfo memory) {
        return recalls[_key(batch)];
    }

    /// @notice The verdict the public page shows, decided on chain.
    function verdictOf(string calldata id) external view returns (Verdict) {
        Box storage b = boxes[_key(id)];
        if (b.stage == Stage.None) return Verdict.Unknown;
        if (recalls[_key(b.batch)].recalled) return Verdict.Recalled;
        if (b.compromised) return Verdict.Compromised;
        if (b.stage == Stage.Sold) return Verdict.Sold;
        if (block.timestamp > b.expiry) return Verdict.Expired;
        if (b.stage == Stage.AtPharmacy) return Verdict.ReadyAtPharmacy;
        return Verdict.InSupplyChain;
    }

    /// @notice True if this file fingerprint matches the certificate registered for the box.
    function checkCertificate(string calldata id, bytes32 fileHash) external view returns (bool) {
        bytes32 h = boxes[_key(id)].certHash;
        return h != bytes32(0) && h == fileHash;
    }

    function getMember(address wallet) external view returns (Member memory member, bool active) {
        member = memberOf[wallet];
        active = member.role != Role.None && member.licenceUntil >= block.timestamp;
    }

    function getMembers() external view returns (address[] memory wallets, Member[] memory members) {
        uint256 n = memberList.length;
        wallets = new address[](n);
        members = new Member[](n);
        for (uint256 i = 0; i < n; i++) {
            wallets[i] = memberList[i];
            members[i] = memberOf[memberList[i]];
        }
    }

    function getBoxIds() external view returns (string[] memory) {
        return boxIds;
    }

    // ------------------------------------------------------------------
    // Internal helpers
    // ------------------------------------------------------------------

    function _key(string memory s) private pure returns (bytes32) {
        return keccak256(bytes(s));
    }

    function _load(string calldata id) private view returns (bytes32 key, Box storage b) {
        key = _key(id);
        b = boxes[key];
        require(b.stage != Stage.None, "No box with this ID exists");
    }

    function _requireActive(address who, Role role, string memory wrongRoleMessage) private view {
        Member storage m = memberOf[who];
        require(role != Role.None && m.role == role, wrongRoleMessage);
        require(m.licenceUntil >= block.timestamp, "Your licence has expired");
    }

    function _requireMovable(Box storage b) private view {
        require(!recalls[_key(b.batch)].recalled, "This batch has been recalled");
        require(!b.compromised, "This box had a temperature breach and is blocked");
    }

    function _record(bytes32 key, string memory kind, string memory note, Stage stage) private {
        history[key].push(Entry(kind, note, stage, msg.sender, memberOf[msg.sender].role, uint64(block.timestamp), uint64(block.number)));
        handled[key][msg.sender] = true;
        emit Step(key, boxes[key].id, kind, msg.sender);
    }

    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
        require(sig.length == 65, "Reading not signed by this box's sensor");
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (v < 27) v += 27;
        // Reject malleable signatures (upper-half s), as OpenZeppelin's ECDSA does.
        require(uint256(s) <= 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0, "Reading not signed by this box's sensor");
        return ecrecover(digest, v, r, s);
    }

    function _tempNote(int16 t) private pure returns (string memory) {
        // Formats tenths of a degree, e.g. 112 -> "Reading 11.2 C is outside 2.0-8.0 C"
        bool neg = t < 0;
        uint256 a = uint256(int256(neg ? -t : t));
        return string(abi.encodePacked(
            "Reading ", neg ? "-" : "", _u(a / 10), ".", _u(a % 10), " C is outside 2.0-8.0 C"
        ));
    }

    function _u(uint256 v) private pure returns (string memory) {
        if (v == 0) return "0";
        bytes memory out;
        while (v > 0) {
            out = abi.encodePacked(bytes1(uint8(48 + (v % 10))), out);
            v /= 10;
        }
        return string(out);
    }
}
