const mongoose=require('mongoose');
const {createHash}=require('node:crypto');
const Bill=require('./Bill');
const Expense=require('../expenses/Expense');
const Group=require('../groups/Group');
const Member=require('../groups/GroupMember');
const {calculateExpenseParticipants}=require('../expenses/expense.split');
const {presentBill}=require('./bill.reminders');
const categoryMap={RENT:'RENT',ELECTRICITY:'UTILITIES',WATER:'UTILITIES',GAS:'UTILITIES',INTERNET:'INTERNET',PHONE:'UTILITIES',SUBSCRIPTION:'SUBSCRIPTIONS',INSURANCE:'OTHERS',ASSOCIATION_DUES:'HOME_MAINTENANCE',EDUCATION:'EDUCATION',CHILDCARE:'OTHERS',LOAN:'OTHERS',CREDIT_CARD:'OTHERS',PROPERTY_TAX:'OTHERS',MAINTENANCE:'HOME_MAINTENANCE',OTHER:'OTHERS'};
function paymentSplit(body,amount,currency){
 if(!body || !mongoose.isObjectIdOrHexString(body.paidBy) || !Array.isArray(body.participants) || !body.participants.length || body.participants.some(p=>!p||!mongoose.isObjectIdOrHexString(p.userId))) return {error:'Choose a payer, split method and active participants.'};
 const participants=body.participants.map(p=>({...p,userId:String(p.userId).toLowerCase()}));
 if(new Set(participants.map(p=>p.userId)).size!==participants.length) return {error:'Duplicate participants are not allowed.'};
 const result=calculateExpenseParticipants({amount,currency,splitType:body.splitType,participants});
 if(result.error)return result;
 return {paidBy:String(body.paidBy).toLowerCase(),splitType:result.splitType,participants:result.participants};
}
const fingerprint=split=>createHash('sha256').update(JSON.stringify(split)).digest('hex');
async function loadPaymentBill(id){return Bill.findById(id).select('+payment');}
async function finishPayment(bill){
 const payment=bill.payment;
 if(!payment || !bill.expenseId) throw Error('Payment reservation missing.');
 const fields={_id:bill.expenseId,billId:bill._id,groupId:bill.groupId,description:payment.description,amount:payment.amount,category:payment.category,notes:payment.notes,date:payment.paidAt,paidBy:payment.paidBy,splitType:payment.splitType,participants:payment.participants};
 let expense;
 try { expense=await Expense.findOneAndUpdate({billId:bill._id},{$setOnInsert:fields},{upsert:true,new:true,runValidators:true}); }
 catch(error){if(error.code!==11000)throw error;expense=await Expense.findOne({billId:bill._id});if(!expense)throw error;}
 if(String(expense._id)!==String(bill.expenseId))throw Error('Bill payment link conflict.');
 const paid=await Bill.findOneAndUpdate({_id:bill._id,expenseId:bill.expenseId,status:{$ne:'PAID'}},{$set:{status:'PAID',paidBy:payment.paidBy,paidAt:payment.paidAt}},{new:true,runValidators:true});
 const result=paid||await Bill.findById(bill._id);
 if(!result || result.status!=='PAID' || String(result.expenseId)!==String(expense._id))throw Error('Bill payment checkpoint not confirmed.');
 return {bill:result,expense};
}
async function payBill(req,res){
 let reserved=false;
 try {
  let bill=await loadPaymentBill(req.params.billId);
  if(!bill)return res.status(404).json({success:false,message:'Bill not found.'});
  if(!await Member.findOne({groupId:bill.groupId,userId:req.user._id,status:'ACTIVE'}))return res.status(403).json({success:false,message:'You do not have access to this bill.'});
  const group=await Group.findById(bill.groupId);
  if(!group || group.deletedAt)return res.status(404).json({success:false,message:'Group not found.'});
  const body=req.body||{};
  if(Object.keys(body).some(key=>!['paidBy','splitType','participants','resume','status','paidAt'].includes(key)))return res.status(400).json({success:false,message:'Save bill edits before recording its payment.'});
  let split;
  if(body.resume===true){
   if(Object.keys(body).some(key=>key!=='resume') || !bill.payment)return res.status(400).json({success:false,message:'There is no saved payment to finish.'});
  }else{
   if(body.resume!==undefined || typeof body.splitType!=='string')return res.status(400).json({success:false,message:'Choose a payer and split settings.'});
   split=paymentSplit(body,bill.amount,group.currency);
   if(split.error)return res.status(400).json({success:false,message:split.error});
  }
  if(bill.status==='PAID' && !bill.payment)return res.status(409).json({success:false,message:'This bill was already paid before linked expenses were supported. No additional expense was created.'});
  if(bill.payment){
   if(split && fingerprint(split)!==bill.payment.fingerprint)return res.status(409).json({success:false,message:'A payment with different payer or split settings is already recorded or processing.'});
  }else{
   const ids=[...new Set([split.paidBy,...split.participants.map(p=>String(p.userId))])];
   const active=await Member.find({groupId:bill.groupId,status:'ACTIVE',userId:{$in:ids}});
   if(ids.some(id=>!active.some(member=>String(member.userId)===id)))return res.status(400).json({success:false,message:'Payer and all participants must be active group members.'});
   const expenseId=new mongoose.Types.ObjectId();
   const payment={...split,description:bill.name,amount:bill.amount,category:categoryMap[bill.category]||'OTHERS',notes:bill.notes||'',paidAt:new Date(),fingerprint:fingerprint(split)};
   await new Expense({_id:expenseId,billId:bill._id,groupId:bill.groupId,...payment,date:payment.paidAt}).validate();
   const claimed=await Bill.findOneAndUpdate({_id:bill._id,status:{$ne:'PAID'},expenseId:null,...(bill.updatedAt?{updatedAt:bill.updatedAt}:{})},{$set:{expenseId,payment}},{new:true,runValidators:true}).select('+payment');
   if(!claimed){
    bill=await loadPaymentBill(bill._id);
    if(!bill?.payment || bill.payment.fingerprint!==payment.fingerprint)return res.status(409).json({success:false,message:'Bill changed or another payment won. Refresh before trying again.'});
   }else bill=claimed;
  }
  reserved=true;
  const result=await finishPayment(bill);
  await result.bill.populate({path:'paidBy',select:'firstName lastName email avatar'});
  return res.json({code:200,success:true,message:'Payment recorded as one linked expense.',data:{bill:presentBill(result.bill),expense:{_id:result.expense._id,billId:result.expense.billId}}});
 }catch(error){
  console.error('Record bill payment:',error);
  return res.status(reserved?503:500).json({success:false,message:reserved?'Payment is being finished. Retry the saved payment; no second expense will be created.':'Could not record the bill payment. Refresh and try again.'});
 }
}
async function recoverBillPayments({onError=console.error}={}){
 const bills=Bill.find({expenseId:{$ne:null},status:{$ne:'PAID'}}).select('+payment').cursor();
 for await(const bill of bills){try{const group=await Group.findById(bill.groupId);if(group && !group.deletedAt && bill.payment)await finishPayment(bill);}catch(error){onError(`Recover bill payment ${bill._id}:`,error);}}
}
async function startBillPaymentWorker({intervalMs=60000,onError=console.error}={}){
 await Expense.createIndexes();
 let running=false;
 async function tick(){if(running)return;running=true;try{await recoverBillPayments({onError});}catch(error){onError('Bill payment recovery:',error);}finally{running=false;}}
 await tick();const timer=setInterval(tick,intervalMs);timer.unref();return ()=>clearInterval(timer);
}
module.exports={payBill,paymentSplit,finishPayment,recoverBillPayments,startBillPaymentWorker,categoryMap};
