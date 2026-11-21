// Event-driven execution: completion advances unfinished work; no clock wakes it.
export function createCognitionDriver({cognition,logger=console,maxPasses=12}: any){
  let running=false,requested=false,closed=false;
  async function drain(){
    if(running||closed)return;
    running=true;
    try{
      for(let passes=0;!closed&&passes<maxPasses;passes++){
        requested=false;
        const before=cognition.workState();
        const ok=await cognition.pump({maxSteps:1});
        const after=cognition.workState();
        if(!ok||after.stamp===before.stamp){if(requested)continue;break;}
        if(!requested&&!after.active&&!after.pending)break;
      }
    }catch(error){logger.warn?.('[cognition-driver]',(error as any)?.message||error);}
    finally{running=false;}
  }
  return {signal(){if(closed)return;requested=true;void drain();},close(){closed=true;cognition.close();},get busy(){return running;}};
}
