const groupIcons = new Set(require('./group.icons.json'));
const Settlement = require('../settlements/Settlement');
const User = require("../users/User");
const Group = require("./Group");
const GroupMember = require("./GroupMember");
const Expense = require("../expenses/Expense");
const Bill = require("../bills/Bill");

// Current ISO 4217 currencies (SIX List One, published 2026-09-17).
// Funds, metals and test codes excluded; amounts use ISO currency minor units.
const groupCurrencies = new Set(require('./group.currencies.json'));

const hasGroupActivity = async (groupId) => {
  const activity = await Promise.all([
    Expense.exists({ groupId }), Bill.exists({ groupId }), Settlement.exists({ groupId })
  ]);
  return activity.some(Boolean);
};

const createGroup = async (req, res) => {
  try {
    const { name } = req.body;

    if (typeof name !== "string" || !name.trim()) {
      return res.status(400).json({
        success: false,
        message: "Group name is required.",
      });
    }

    const currency = req.body.currency === undefined
      ? 'PHP'
      : typeof req.body.currency === 'string' ? req.body.currency.trim().toUpperCase() : null;
    if (!groupCurrencies.has(currency)) {
      return res.status(400).json({
        success: false,
        message: 'Choose a supported currency from the currency list.',
      });
    }

    const icon = req.body.icon === undefined ? 'people' : req.body.icon;
    if (!groupIcons.has(icon)) return res.status(400).json({ success: false, message: 'Choose a supported group icon.' });

    const group = await Group.create({
      name: name.trim(),
      ownerId: req.user._id,
      currency,
      icon,
    });

    await GroupMember.create({
      groupId: group._id,
      userId: req.user._id,
      role: "OWNER",
    });

    return res.status(201).json({
      success: true,
      message: "Group created successfully.",
      data: {
        group,
      },
    });
  } catch (error) {
    console.error("Create group error:", error);

    return res.status(500).json({
      success: false,
      message: "Something went wrong while creating the group.",
    });
  }
};

const getMyGroups = async (req, res) => {
  try {
    const memberships = await GroupMember.find({
      userId: req.user._id,
      status: "ACTIVE",
    }).populate({
      path: "groupId",
      populate: {
        path: "ownerId",
        select: "firstName lastName email",
      },
    });

    // Population can return null for deleted groups, or undefined for legacy
    // memberships that have not yet had householdId migrated to groupId.
    const groups = memberships
      .filter((membership) => membership.groupId && !membership.groupId.deletedAt)
      .map((membership) => ({
        id: membership.groupId._id,
        name: membership.groupId.name,
        currency: membership.groupId.currency,
        icon: membership.groupId.icon ?? 'people',
        role: membership.role,
        owner: membership.groupId.ownerId,
        joinedAt: membership.joinedAt,
      }));

    return res.status(200).json({
      success: true,
      data: {
        groups,
      },
    });
  } catch (error) {
    console.error("Get groups error:", error);

    return res.status(500).json({
      success: false,
      message: "Something went wrong while retrieving your groups.",
    });
  }
};

const getGroupById = async (req, res) => {
  try {
    const members = await GroupMember.find({
      groupId: req.group._id,
      status: "ACTIVE",
    }).populate({
      path: "userId",
      select: "firstName lastName email avatar",
    });

    const canChangeCurrency = String(req.group.ownerId) === String(req.user._id) &&
      !await hasGroupActivity(req.group._id);

    return res.status(200).json({
      success: true,
      data: {
        group: {
          id: req.group._id,
          name: req.group.name,
          currency: req.group.currency,
          canChangeCurrency,
          icon: req.group.icon ?? 'people',
          ownerId: req.group.ownerId,
          role: req.membership.role,
          createdAt: req.group.createdAt,
          updatedAt: req.group.updatedAt,
        },

        members: members.map((member) => ({
          id: member.userId._id,
          firstName: member.userId.firstName,
          lastName: member.userId.lastName,
          email: member.userId.email,
          avatar: member.userId.avatar,
          role: member.role,
          joinedAt: member.joinedAt,
        })),
      },
    });
  } catch (error) {
    console.error("Get group error:", error);

    return res.status(500).json({
      success: false,
      message: "Something went wrong while retrieving the group.",
    });
  }
};

const addGroupMember = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Email is required.",
      });
    }

    // Only the group owner can add members
    if (req.membership.role !== "OWNER") {
      return res.status(403).json({
        success: false,
        message: "Only the group owner can add members.",
      });
    }

    // Find the user
    const user = await User.findOne({
      email: email.toLowerCase(),
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "No user found with this email.",
      });
    }

    // Check if already a member
    const existingMembership = await GroupMember.findOne({
      groupId: req.group._id,
      userId: user._id,
    });

    if (existingMembership && existingMembership.status !== "INACTIVE") {
      return res.status(409).json({
        success: false,
        message: "User is already a member of this group.",
      });
    }

    // Reuse removed memberships so rejoining does not create duplicate records.
    let membership;
    if (existingMembership) {
      existingMembership.status = "ACTIVE";
      existingMembership.role = "MEMBER";
      existingMembership.joinedAt = new Date();
      membership = await existingMembership.save();
    } else {
      membership = await GroupMember.create({
        groupId: req.group._id,
        userId: user._id,
        role: "MEMBER",
      });
    }

    return res.status(201).json({
      success: true,
      message: "Member added successfully.",
      data: {
        member: {
          id: user._id,
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
          role: membership.role,
          joinedAt: membership.joinedAt,
        },
      },
    });
  } catch (error) {
    console.error("Add group member error:", error);

    return res.status(500).json({
      success: false,
      message: "Something went wrong while adding the member.",
    });
  }
};

const removeGroupMember = async (req, res) => {
  try {
    const { userId } = req.params;

    // Only the owner can remove members
    if (req.membership.role !== "OWNER") {
      return res.status(403).json({
        success: false,
        message: "Only the group owner can remove members.",
      });
    }

    // Prevent the owner from removing themselves
    if (req.user._id.toString() === userId) {
      return res.status(400).json({
        success: false,
        message: "The group owner cannot remove themselves.",
      });
    }

    const membership = await GroupMember.findOne({
      groupId: req.group._id,
      userId,
      status: "ACTIVE",
    });

    if (!membership) {
      return res.status(404).json({
        success: false,
        message: "Group member not found.",
      });
    }

    membership.status = "INACTIVE";
    await membership.save();

    return res.status(200).json({
      success: true,
      message: "Member removed successfully.",
    });
  } catch (error) {
    console.error("Remove group member error:", error);

    return res.status(500).json({
      success: false,
      message: "Something went wrong while removing the member.",
    });
  }
};

const getGroupMembers = async (req, res) => {
  try {
    const { id: groupId } = req.params;

    const members = await GroupMember.find({
      groupId,
      status: "ACTIVE",
    })
      .populate({
        path: "userId",
        select: "firstName lastName email avatar",
      })
      .sort({
        role: 1,
        joinedAt: 1,
      });

    return res.status(200).json({
      code: 200,
      success: true,
      message: "Group members retrieved successfully.",
      data: {
        members,
      },
    });
  } catch (error) {
    console.error("Get group members error:", error);

    return res.status(500).json({
      code: 500,
      success: false,
      message: "Something went wrong while retrieving group members.",
    });
  }
};

const updateGroup = async (req, res) => {
  try {
    const { id: groupId } = req.params;
    const { name, currency, icon } = req.body;

    const group = await Group.findById(groupId);

    if (!group) {
      return res.status(404).json({
        code: 404,
        success: false,
        message: "Group not found.",
      });
    }

    // Only the owner can update the group
    if (group.ownerId.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        code: 403,
        success: false,
        message: "Only the group owner can update this group.",
      });
    }

    if (icon !== undefined && !groupIcons.has(icon)) return res.status(400).json({ success: false, message: 'Choose a supported group icon.' });

    if (name !== undefined) {
      const updatedName = name.trim();

      if (!updatedName) {
        return res.status(400).json({
          code: 400,
          success: false,
          message: "Group name is required.",
        });
      }

      group.name = updatedName;
    }

    if (currency !== undefined) {
      const updatedCurrency = typeof currency === 'string' ? currency.trim().toUpperCase() : '';
      if (!groupCurrencies.has(updatedCurrency)) return res.status(400).json({ success: false, message: 'Choose a supported currency from the currency list.' });
      if (updatedCurrency !== group.currency) {
        if (await hasGroupActivity(group._id)) return res.status(409).json({ success: false, message: 'Currency cannot change after expenses, bills or payments have been recorded.' });
      }
      group.currency = updatedCurrency;
    }

    if (icon !== undefined) group.icon = icon;

    await group.save();

    return res.status(200).json({
      code: 200,
      success: true,
      message: "Group updated successfully.",
      data: {
        group,
      },
    });
  } catch (error) {
    console.error("Update group error:", error);

    return res.status(500).json({
      code: 500,
      success: false,
      message: "Something went wrong while updating the group.",
    });
  }
};

const deleteGroup = async (req, res) => {
  try {
    const { id: groupId } = req.params;

    const group = await Group.findById(groupId).setOptions({withDeleted:true});

    if (!group) {
      return res.status(404).json({
        code: 404,
        success: false,
        message: "Group not found.",
      });
    }

    // Only the owner can delete the group
    if (group.ownerId.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        code: 403,
        success: false,
        message: "Only the group owner can delete this group.",
      });
    }

    await Group.findByIdAndDelete(groupId).setOptions({withDeleted:true});

    // Remove group memberships
    await GroupMember.deleteMany({
      groupId,
    });

    // Remove group expenses
    await Expense.deleteMany({
      groupId,
    });

    // Remove recorded settlement payments
    await Settlement.deleteMany({ groupId });

    // Remove group bills
    await Bill.deleteMany({
      groupId,
    });

    return res.status(200).json({
      code: 200,
      success: true,
      message: "Group deleted successfully.",
    });
  } catch (error) {
    console.error("Delete group error:", error);

    return res.status(500).json({
      code: 500,
      success: false,
      message: "Something went wrong while deleting the group.",
    });
  }
};

module.exports = {
  createGroup,
  getMyGroups,
  getGroupById,
  addGroupMember,
  removeGroupMember,
  getGroupMembers,
  updateGroup,
  deleteGroup,
};
