const Group = require('./Group');
const GroupMember = require('./GroupMember');

const groupAccess = async (req, res, next) => {
  try {
    const { id } = req.params;

    const group = await Group.findById(id);

    if (!group || group.deletedAt) {
      return res.status(404).json({
        success: false,
        message: 'Group not found.'
      });
    }

    const membership = await GroupMember.findOne({
      groupId: id,
      userId: req.user._id,
      status: 'ACTIVE'
    });

    if (!membership) {
      return res.status(403).json({
        success: false,
        message: 'You do not have access to this group.'
      });
    }

    req.group = group;
    req.membership = membership;

    next();
  } catch (error) {
    console.error('Group access error:', error);

    return res.status(500).json({
      success: false,
      message: 'Something went wrong while checking group access.'
    });
  }
};

module.exports = {
  groupAccess
};