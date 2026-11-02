// Single-owner MCP contract. Conversation context is routing data, never authentication.
export const PROTOCOL_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export function protocolVersion(requested) { return PROTOCOL_VERSIONS.includes(requested) ? requested : '2025-06-18'; }
export function capabilities(version) { return version === '2026-07-28' ? {tools: {}, events: {}} : {tools: {}}; }
const id = {type:'integer', minimum:1};
const text = {type:'string', minLength:1, maxLength:20000};
const context = {type:'object', properties:{host:{type:'string',enum:['chatgpt','shiyan_desktop','shiyan_mobile','weixin','other']}, conversation_id:{type:'string',minLength:1,maxLength:200}}, required:['host','conversation_id'], additionalProperties:false};
const consumer = {type:'string',minLength:1,maxLength:200};
const requestId={type:'string',minLength:1,maxLength:128,pattern:'^[A-Za-z0-9][A-Za-z0-9._:-]*$'};
const owner={type:'string',minLength:1,maxLength:200,pattern:'^[A-Za-z0-9][A-Za-z0-9._:-]*$',default:'shiyan-private-owner'};
const limit = {type:'integer',minimum:1,maximum:200,default:50};
const read = {readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false};
const write = {readOnlyHint:false,destructiveHint:false,openWorldHint:false};
function tool(name, description, properties, required, annotations=read) {
 const securitySchemes=[{type:'noauth'}];
 return {name,description,inputSchema:{type:'object',properties,required,additionalProperties:false},annotations,securitySchemes,_meta:{securitySchemes}};
}
export function toolList() { return [
 tool('dots_get_relationship','Read evidenced shared topics and observed conversation rhythm. Reading does not initiate conversation.',{owner_id:owner},[]),
 tool('dots_update_relationship_topic','Correct a shared topic at the user’s request. This edits relationship memory, not task instructions.',{owner_id:owner,topicId:{type:'string',minLength:1,maxLength:128,pattern:'^[A-Za-z0-9_-]+$'},title:{type:'string',minLength:1,maxLength:200},summary:{type:'string',maxLength:4000},openQuestion:{type:'string',maxLength:2000},revision:{type:'integer',minimum:0}},['topicId'],{...write,idempotentHint:true}),
 tool('dots_delete_relationship_topic','Forget a shared topic at the user’s request and invalidate its unsent conversation candidates.',{owner_id:owner,topicId:{type:'string',minLength:1,maxLength:128,pattern:'^[A-Za-z0-9_-]+$'}},['topicId'],{...write,idempotentHint:true,destructiveHint:true}),
 tool('dots_get_manager','Read the persistent private manager, its shared messages and delegated tasks. Reach the same manager across Shiyan devices. owner_id is routing data, not authentication.',{owner_id:owner},[]),
 tool('dots_get_manager_messages','Read older persisted manager messages before an id. Pages are returned in conversation order. Loading history never starts work or acknowledges user receipt.',{owner_id:owner,before_id:{type:'integer',minimum:1},limit},[]),
 tool('dots_message_manager','Send a durable instruction to the manager while delegated tasks keep running. Reuse request_id after connection loss. task_id explicitly targets an existing task; status questions should not create work. A receipt is not proof that the instruction has finished.',{owner_id:owner,message:text,request_id:requestId,host:context.properties.host,task_id:id},['message','request_id'],{...write,idempotentHint:true}),
 tool('dots_control_manager','Control manager coordination. Pause stops new coordination, not every worker. Cancel stops current manager work and delegated tasks; completed effects remain. Resume and wake apply to the manager, not cancelled child tasks. Interrupt stops only the manager reply currently being generated; delegated tasks keep running.',{owner_id:owner,action:{type:'string',enum:['pause','resume','cancel','wake','interrupt']},request_id:requestId},['action'],{...write,destructiveHint:true}),
 tool('dots_get_manager_activity','Read durable manager and delegated-task activity after a cursor. Activity replay does not confirm a notification was displayed or read.',{owner_id:owner,after_id:{type:'integer',minimum:0},limit},[]),
 tool('dots_reconcile_action','Record a verified outcome for an uncertain action only after the user has explicitly reviewed that specific outcome and evidence. Do not guess or invent consent. This records evidence and releases the associated lock; it does not repeat the original command.',{action_id:{type:'string',minLength:1,maxLength:128,pattern:'^[A-Za-z0-9][A-Za-z0-9._:-]*$'},outcome:{type:'string',enum:['succeeded','failed']},note:{...text,maxLength:4000},request_id:requestId},['action_id','outcome','note','request_id'],{...write,destructiveHint:true,idempotentHint:true}),
 tool('dots_create_goal','Create a persistent goal. Bind client_context to the originating conversation when known. After creation ensure a host-provided goal.notification subscription; do not invent callbacks or claim delivery without verification.',{title:{...text,maxLength:200},instruction:text,request_id:requestId,run_now:{type:'boolean',default:true},client_context:context},['title','instruction'],write),
 tool('dots_get_goal','Read one goal, its state, timeline, approval requests and output references.',{goal_id:id},['goal_id']),
 tool('dots_read_output','Read the full stored result and summary for one output.',{output_id:id},['output_id']),
 tool('dots_instruct_goal','Continue an existing goal with new instructions. Terminal or paused goals require explicit resume first. Reuse the existing event subscription.',{goal_id:id,message:text,request_id:requestId},['goal_id','message'],write),
 tool('dots_list_goals','List persistent goals. Optional client_context matches the originating conversation exactly. This private relay is single owner; context is not an authorization boundary.',{status:{type:'string',enum:['active','paused','done','blocked','waiting_approval','cancelled']},client_context:context,limit},[]),
 tool('dots_control_goal','Pause, resume, cancel or wake a goal only when the user asks. Pause/cancel stop future steps; an already running Codex turn or OS command may finish. Cancelled/done goals cannot be resumed.',{goal_id:id,action:{type:'string',enum:['pause','resume','cancel','wake']}},['goal_id','action'],{...write,destructiveHint:true}),
 tool('dots_get_timeline','Read ordered durable progress records after a cursor. This is reconnect replay, not a promise of live delivery.',{goal_id:id,after_id:{type:'integer',minimum:0},limit},['goal_id']),
 tool('dots_list_outputs','List result references for one goal; use dots_read_output for full text.',{goal_id:id,limit},['goal_id']),
 tool('dots_list_notifications','Read ordered durable notifications after a cursor, optionally scoped to a goal/conversation. Reading does not acknowledge, deliver or display them. consumer_id maintains an independent device cursor.',{after_id:{type:'integer',minimum:0},goal_id:id,client_context:context,consumer_id:consumer,limit},[]),
 tool('dots_ack_notifications','Acknowledge durable handoff after storing notifications. This advances only the named consumer cursor, never user receipt or webhook delivery. notification_id must identify a stored notification.',{consumer_id:consumer,notification_id:id},['consumer_id','notification_id'],{...write,idempotentHint:true}),
 tool('dots_list_approvals','List pending approval requests with the exact proposed commands. Reading a request never authorizes execution.',{goal_id:id},[]),
 tool('dots_decide_approval','Decide an approval only after explicit user consent. For approve, confirmed_command must exactly match the command the user reviewed; never supply it on the user’s behalf without consent. Reject does not execute the command.',{approval_id:id,decision:{type:'string',enum:['approve','reject']},confirmed_command:{type:'string',maxLength:20000}},['approval_id','decision'],{...write,destructiveHint:true,openWorldHint:true}),
 tool('dots_notification_status','Inspect subscription verification, expiry, last webhook outcome and queued delivery counts. No callback URLs or signing secrets are returned. A webhook acceptance is not proof of display in a conversation.',{goal_id:id},[]),
 tool('dots_get_capabilities','Describe protocol versions, lifecycle tools, conversation routing and notification support. Shiyan UI integration requires a host adapter and is not installed by this plugin.',{},[])
]; }
export function validateToolArguments(name,args) {
 const definition=toolList().find(t=>t.name===name);
 if(!definition)throw Object.assign(new Error('Unknown tool'),{rpcCode:-32601});
 function check(schema,value,at){
  if(schema.type==='object'){
   if(!value||typeof value!=='object'||Array.isArray(value))throw new Error(at+' must be an object');
   for(const k of schema.required||[])if(value[k]===undefined)throw new Error(at+'.'+k+' is required');
   for(const[k,v]of Object.entries(value)){if(!schema.properties[k])throw new Error(at+'.'+k+' is not supported');check(schema.properties[k],v,at+'.'+k);}
  }else if(schema.type==='integer'){if(!Number.isSafeInteger(value)||value<(schema.minimum??-Infinity)||value>(schema.maximum??Infinity))throw new Error(at+' must be a valid integer');}
  else if(schema.type==='string'){if(typeof value!=='string'||value.length<(schema.minLength||0)||value.length>(schema.maxLength||Infinity)||schema.minLength&&!value.trim())throw new Error(at+' must be a valid string');}
  else if(schema.type==='boolean'&&typeof value!=='boolean')throw new Error(at+' must be boolean');
  if(schema.pattern&&!new RegExp(schema.pattern).test(value))throw new Error(at+' has invalid characters');
  if(schema.enum&&!schema.enum.includes(value))throw new Error(at+' is not supported');
 }
 try{check(definition.inputSchema,args,'arguments');}catch(e){e.rpcCode=-32602;throw e;}
 return args;
}
export const CLIENT_CONTEXT_SCHEMA=context;
