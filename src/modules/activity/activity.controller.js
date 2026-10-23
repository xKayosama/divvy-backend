const Activity = require('./Activity');
async function getActivity(req, res) {
  try {
    const { page = '1', limit = '20' } = req.query;
    if (typeof page !== 'string' || !/^[1-9]\d*$/.test(page) || Number(page) > 1000000 || typeof limit !== 'string' || !/^[1-9]\d*$/.test(limit) || Number(limit) > 100) {
      return res.status(400).json({ success: false, message: 'Use a positive page and a limit from 1 to 100.' });
    }
    const filter = { groupId: req.params.id };
    const [activities, total] = await Promise.all([
      Activity.find(filter).sort({ occurredAt: -1, _id: -1 }).skip((Number(page) - 1) * Number(limit)).limit(Number(limit)).populate('actor', 'firstName lastName').lean(),
      Activity.countDocuments(filter),
    ]);
    return res.json({ success: true, data: { activities: activities.map(({ _id, actor, action, targetId, label, changes, snapshot, occurredAt }) => ({ _id, actor, action, targetId, label, changes, snapshot, occurredAt })), pagination: { page: Number(page), limit: Number(limit), total, totalPages: Math.ceil(total / Number(limit)) } } });
  } catch (error) {
    console.error('Get activity:', error);
    return res.status(500).json({ success: false, message: 'Could not load activity history.' });
  }
}
module.exports = { getActivity };
