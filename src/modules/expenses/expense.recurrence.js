const {recordActivity,expenseSnapshot,changesBetween}=require('../activity/activity.service');
const { randomUUID } = require('node:crypto');
const Expense = require('./Expense');
const Member = require('../groups/GroupMember');
const Group = require('../groups/Group');
const { money } = require('../../utils/money');
const { occurrenceDate } = require('../bills/bill.recurrence');
const FREQUENCIES = ['WEEKLY', 'MONTHLY', 'YEARLY'];
const unlocked = now => ({ $or: [{ 'recurring.lockedUntil': { $exists: false } }, { 'recurring.lockedUntil': null }, { 'recurring.lockedUntil': { $lte: now } }] });
function endDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('End date must use YYYY-MM-DD.');
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0,10) !== value) throw new Error('Enter a valid end date.');
  date.setUTCHours(23,59,59,999);
  return date;
}
function withinEnd(date, end) { return !end || date <= new Date(end); }
function createSchedule(value, anchor) {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value) || !FREQUENCIES.includes(value.frequency) || Object.keys(value).some(key => !['frequency','endDate'].includes(key))) throw new Error('Choose a weekly, monthly or yearly schedule.');
  const start = new Date(anchor);
  if (!Number.isFinite(start.getTime())) throw new Error('Enter a valid expense date.');
  const end = endDate(value.endDate);
  if (end && end < start) throw new Error('End date must be on or after the first expense date.');
  const next = occurrenceDate(start,value.frequency,1);
  return { frequency:value.frequency, anchor:start, endDate:end, paused:false, nextNumber:1, nextDate:withinEnd(next,end)?next:null, lastError:'' };
}
function nextAfter(anchor, frequency, now, minimum = 1) {
  anchor = new Date(anchor);
  let number = frequency === 'WEEKLY' ? Math.floor((now-anchor)/(7*86400000))+1 : frequency === 'MONTHLY' ? (now.getUTCFullYear()-anchor.getUTCFullYear())*12+now.getUTCMonth()-anchor.getUTCMonth() : now.getUTCFullYear()-anchor.getUTCFullYear();
  number = Math.max(minimum,number,1);
  while (occurrenceDate(anchor,frequency,number) <= now) number++;
  return number;
}

async function generateRecurringExpenses({now = new Date(), maxPerSource = 120, onError = console.error} = {}) {
  const sources = Expense.find({ 'recurring.paused':false, 'recurring.nextDate':{$lte:now,$ne:null}, recurrenceSourceId:null }).cursor();
  for await (const candidate of sources) {
    for (let count=0;count<maxPerSource;count++) {
      const token = randomUUID();
      const clock = new Date();
      let source;
      try {
        source = await Expense.findOneAndUpdate({ _id:candidate._id, 'recurring.paused':false, 'recurring.nextDate':{$lte:now,$ne:null}, ...unlocked(clock) }, { $set:{'recurring.lockToken':token,'recurring.lockedUntil':new Date(clock.getTime()+60000)} },{new:true}).select('+recurring.lockToken +recurring.lockedUntil');
        if (!source) break;
        const schedule = source.recurring;
        const due = occurrenceDate(schedule.anchor,schedule.frequency,schedule.nextNumber);
        if (!withinEnd(due,schedule.endDate)) {
          await Expense.updateOne({_id:source._id,'recurring.lockToken':token},{$set:{'recurring.nextDate':null}});
          break;
        }
        const group = await Group.findById(source.groupId);
        const ids = [...new Set([String(source.paidBy),...source.participants.map(p=>String(p.userId))])];
        const active = await Member.find({groupId:source.groupId,status:'ACTIVE',userId:{$in:ids}});
        const validMembers = group && !group.deletedAt && ids.every(id=>active.some(member=>String(member.userId)===id));
        if (!validMembers) {
          await Expense.updateOne({_id:source._id,'recurring.lockToken':token},{$set:{'recurring.paused':true,'recurring.lastError':'Schedule paused: payer or assigned members are unavailable. Review the expense before resuming.'}});
          break;
        }
        const m = money(group.currency);
        if (!m.valid(source.amount)) throw new Error('Saved expense amount is invalid.');
        const total = m.readUnits(source.amount);
        if (source.participants.reduce((sum,p)=>sum+BigInt(m.readUnits(p.amount)),0n)!==BigInt(total)) throw new Error('Saved split no longer matches the amount.');
        // Recheck the lease before inserting; expired workers leave progress to a retry.
        if (!await Expense.exists({_id:source._id,'recurring.lockToken':token,'recurring.lockedUntil':{$gt:new Date()}})) break;
        const key={recurrenceSourceId:source._id,occurrenceNumber:schedule.nextNumber};
        const plain = source.toObject();
        try {
          await Expense.updateOne(key,{$setOnInsert:{...key,groupId:source.groupId,description:source.description,amount:source.amount,category:source.category,paidBy:source.paidBy,splitType:source.splitType,participants:plain.participants,items:plain.items,adjustments:plain.adjustments,notes:source.notes,date:due}},{upsert:true,runValidators:true});
        } catch(error) {
          if(error.code!==11000 || !await Expense.exists(key)) throw error;
        }
        const generated = await Expense.findOne(key);
        if (generated) await recordActivity({groupId:source.groupId,actor:null,action:'EXPENSE_ADDED',targetId:generated._id,label:generated.description,snapshot:{...expenseSnapshot(generated,group.currency),automatic:true},occurredAt:generated.createdAt || new Date(),eventKey:`expense-added:${generated._id}`});
        const nextNumber=schedule.nextNumber+1;
        const next=occurrenceDate(schedule.anchor,schedule.frequency,nextNumber);
        await Expense.updateOne({_id:source._id,'recurring.lockToken':token,'recurring.nextNumber':schedule.nextNumber},{$set:{'recurring.nextNumber':nextNumber,'recurring.nextDate':withinEnd(next,schedule.endDate)?next:null,'recurring.lastError':''}});
      } catch(error) {
        onError(`Recurring expense ${candidate._id}:`,error);
        break;
      } finally {
        if(source) await Expense.updateOne({_id:source._id,'recurring.lockToken':token},{$unset:{'recurring.lockToken':1,'recurring.lockedUntil':1}}).catch(error=>onError('Recurring expense unlock:',error));
      }
    }
  }
}
async function updateRecurrence(req,res) {
  try {
    const source=await Expense.findById(req.params.expenseId);
    if(!source) return res.status(404).json({success:false,message:'Expense not found.'});
    if(!await Member.findOne({groupId:source.groupId,userId:req.user._id,status:'ACTIVE'})) return res.status(403).json({success:false,message:'You do not have access to this expense.'});
    if(!source.recurring || source.recurrenceSourceId) return res.status(400).json({success:false,message:'This expense does not manage a recurring schedule.'});
    const body=req.body;
    if(!body || Array.isArray(body) || !Object.keys(body).length || Object.keys(body).some(key=>!['paused','endDate'].includes(key)) || (body.paused!==undefined && typeof body.paused!=='boolean')) return res.status(400).json({success:false,message:'Supply paused and/or endDate.'});
    const now=new Date();
    const scheduleBefore={paused:source.recurring.paused,endDate:source.recurring.endDate || null};
    const schedule=source.recurring.toObject ? source.recurring.toObject() : {...source.recurring};
    if(body.endDate!==undefined) schedule.endDate=endDate(body.endDate);
    if(schedule.endDate && new Date(schedule.endDate)<new Date(schedule.anchor)) throw new Error('End date must be on or after the first expense date.');
    if(body.paused!==undefined) schedule.paused=body.paused;
    if((body.paused===false && source.recurring.paused) || (!source.recurring.nextDate && body.endDate!==undefined)) schedule.nextNumber=nextAfter(schedule.anchor,schedule.frequency,now,schedule.nextNumber);
    const next=occurrenceDate(schedule.anchor,schedule.frequency,schedule.nextNumber);
    schedule.nextDate=withinEnd(next,schedule.endDate)?next:null;
    schedule.lastError='';
    delete schedule.lockToken;delete schedule.lockedUntil;
    // Also compare progress: a worker finishing while this request validates must not be rewound.
    const updated=await Expense.findOneAndUpdate({_id:source._id,'recurring.nextNumber':source.recurring.nextNumber,...unlocked(now)},{$set:{recurring:schedule}},{new:true,runValidators:true});
    if(!updated) return res.status(409).json({success:false,message:'Schedule is processing or changed. Refresh and try again.'});
    const scheduleChanges=changesBetween(scheduleBefore,{paused:schedule.paused,endDate:schedule.endDate || null});
    if(Object.keys(scheduleChanges).length) await recordActivity({groupId:source.groupId,actor:req.user._id,action:'EXPENSE_EDITED',targetId:source._id,label:source.description,changes:scheduleChanges});
    await updated.populate([{path:'paidBy',select:'firstName lastName email avatar'},{path:'participants.userId',select:'firstName lastName email avatar'}]);
    return res.json({success:true,data:{expense:updated}});
  } catch(error) {
    if(error.message?.includes('End date') || error.message?.includes('end date')) return res.status(400).json({success:false,message:error.message});
    console.error('Update recurring expense:',error);
    return res.status(500).json({success:false,message:'Could not update the recurring schedule.'});
  }
}
async function startRecurringExpenseWorker({intervalMs=60000,onError=console.error}={}) {
  await Expense.createIndexes();
  let running=false;
  async function tick(){if(running)return;running=true;try{await generateRecurringExpenses({onError});}catch(error){onError('Recurring expense worker:',error);}finally{running=false;}}
  await tick();
  const timer=setInterval(tick,intervalMs);timer.unref();
  return ()=>clearInterval(timer);
}
module.exports={createSchedule,endDate,nextAfter,withinEnd,unlocked,generateRecurringExpenses,updateRecurrence,startRecurringExpenseWorker,occurrenceDate};
