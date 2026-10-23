const Group=require('./Group');
const Member=require('./GroupMember');
const Expense=require('../expenses/Expense');
const Bill=require('../bills/Bill');
async function ownerIncludingDeleted(req,res,next){
 try{
  const group=await Group.findById(req.params.id).setOptions({withDeleted:true});
  if(!group)return res.status(404).json({success:false,message:'Group not found.'});
  if(String(group.ownerId)!==String(req.user._id) || !await Member.findOne({groupId:group._id,userId:req.user._id,status:'ACTIVE'}))return res.status(403).json({success:false,message:'Only the active group owner can manage deletion or restoration.'});
  req.group=group;next();
 }catch(error){console.error('Group lifecycle access:',error);return res.status(500).json({success:false,message:'Could not check group ownership.'});}
}
async function softDeleteGroup(req,res){
 try{
  const group=await Group.findOneAndUpdate({_id:req.group._id,ownerId:req.user._id,deletedAt:null},{$set:{deletedAt:new Date(),deletedBy:req.user._id}},{new:true});
  // Children are retained. Restored expense schedules require explicit resume.
  await Expense.updateMany({groupId:req.group._id,'recurring.paused':false},{$set:{'recurring.paused':true}});
  const result=group||await Group.findById(req.group._id).setOptions({withDeleted:true});
  if(!result)return res.status(404).json({success:false,message:'Group was permanently deleted.'});
  if(!result.deletedAt)return res.status(409).json({success:false,message:'Group state changed. Refresh and retry.'});
  return res.json({success:true,message:'Group moved to Deleted groups. Its records are preserved.',data:{group:result}});
 }catch(error){console.error('Soft delete group:',error);return res.status(500).json({success:false,message:'Could not finish soft deletion. Refresh and retry.'});}
}
async function restoreGroup(req,res){
 try{
  if(!req.group.deletedAt)return res.json({success:true,message:'Group is already active.',data:{group:req.group}});
  await Expense.updateMany({groupId:req.group._id,'recurring.paused':false},{$set:{'recurring.paused':true}});
  const {nextAfter}=require('../expenses/expense.recurrence');
  const now=new Date();
  const sources=await Bill.find({groupId:req.group._id,isRecurring:true,recurrenceSourceId:null});
  // Skip missed periods while hidden. Existing unpaid/paid records stay intact.
  for(const source of sources){const through=nextAfter(source.dueDate,source.recurrence,now,1)-1;await Bill.updateOne({_id:source._id},{$max:{generatedThrough:through}});}
  const group=await Group.findOneAndUpdate({_id:req.group._id,ownerId:req.user._id,deletedAt:{$ne:null}},{$set:{deletedAt:null,deletedBy:null}},{new:true,withDeleted:true});
  const result=group||await Group.findById(req.group._id).setOptions({withDeleted:true});
  if(!result)return res.status(404).json({success:false,message:'Group was permanently deleted.'});
  if(result.deletedAt)return res.status(409).json({success:false,message:'Group state changed. Refresh and retry.'});
  return res.json({success:true,message:'Group restored. Review paused recurring expenses before resuming.',data:{group:result}});
 }catch(error){console.error('Restore group:',error);return res.status(500).json({success:false,message:'Could not restore the group. Retry safely.'});}
}
async function deletedGroups(req,res){
 try{
  const groups=await Group.find({ownerId:req.user._id,deletedAt:{$ne:null}}).setOptions({withDeleted:true}).sort({deletedAt:-1});
  return res.json({success:true,data:{groups:groups.map(group=>({id:group._id,name:group.name,currency:group.currency,icon:group.icon,role:'OWNER',deletedAt:group.deletedAt}))}});
 }catch(error){console.error('Deleted groups:',error);return res.status(500).json({success:false,message:'Could not load deleted groups.'});}
}
function activeRecordGroup(Model,param){return async(req,res,next)=>{
 try{
  const record=await Model.findById(req.params[param]).select('groupId');
  if(!record)return next();
  const group=await Group.findById(record.groupId);
  if(!group || group.deletedAt)return res.status(404).json({success:false,message:'Group not found or deleted.'});
  next();
 }catch(error){if(error.name==='CastError')return res.status(404).json({success:false,message:'Record not found.'});console.error('Record group access:',error);return res.status(500).json({success:false,message:'Could not check group access.'});}
};}
module.exports={ownerIncludingDeleted,softDeleteGroup,restoreGroup,deletedGroups,activeRecordGroup};
