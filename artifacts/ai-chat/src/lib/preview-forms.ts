/**
 * Sandboxed forms cannot enter the browser's native submission algorithm.
 * Dispatch local handlers instead; never enable allow-forms or navigate.
 */
export function previewFormInstrumentation(): string {
  return `(function(){
    function submitLocally(form,submitter){
      if(!form||!form.isConnected)return;
      if(!(form.noValidate||(submitter&&submitter.formNoValidate))&&!form.reportValidity())return;
      var event;
      if(typeof SubmitEvent==='function'){
        event=new SubmitEvent('submit',{bubbles:true,cancelable:true,submitter:submitter||null});
      }else{
        event=new Event('submit',{bubbles:true,cancelable:true});
        Object.defineProperty(event,'submitter',{value:submitter||null});
      }
      form.dispatchEvent(event);
    }
    function isSubmitter(control){
      return control&&((control.tagName==='BUTTON'&&control.type==='submit')||
        (control.tagName==='INPUT'&&(control.type==='submit'||control.type==='image')));
    }
    window.addEventListener('click',function(event){
      if(event.defaultPrevented||event.button!==0)return;
      var target=event.target;
      var control=target&&typeof target.closest==='function'?target.closest('button,input'):null;
      if(!isSubmitter(control)||control.matches(':disabled')||!control.form)return;
      event.preventDefault();
      submitLocally(control.form,control);
    });
    window.addEventListener('keydown',function(event){
      if(event.defaultPrevented||event.key!=='Enter'||event.isComposing||event.ctrlKey||event.altKey||event.metaKey)return;
      var input=event.target;
      if(!input||input.tagName!=='INPUT'||!input.form||input.matches(':disabled')||
        !['text','search','email','url','tel','password','number'].includes(input.type))return;
      var form=input.form;
      var submitter=Array.from(form.elements).find(function(control){return isSubmitter(control)&&!control.matches(':disabled');});
      event.preventDefault();
      submitLocally(form,submitter||null);
    });
    if(typeof HTMLFormElement==='function'){
      Object.defineProperty(HTMLFormElement.prototype,'requestSubmit',{
        configurable:true,writable:true,value:function(submitter){
          if(submitter!==undefined&&submitter!==null){
            if(!isSubmitter(submitter))throw new TypeError('requestSubmit requires a submit button.');
            if(submitter.form!==this)throw new DOMException('The submit button belongs to a different form.','NotFoundError');
          }
          submitLocally(this,submitter||null);
        }
      });
    }
  })();`;
}
