(function(){
  const Demo=globalThis.RollandsDemoScenario,Flows=globalThis.RollandsDemoWorkflows;
  const isDemo=location.hostname.endsWith('github.io')||new URLSearchParams(location.search).has('demo');
  if(!isDemo||!Demo||!Flows)return;
  document.addEventListener('click',event=>{
    const button=event.target.closest('[data-action="approve"][data-id]');if(!button)return;
    const proposal=Demo.section('automationProposals').find(row=>row.id===button.dataset.id);if(!proposal)return;
    try{
      if(proposal.type==='bank-payment-match')Flows.applyCustomerPayment(proposal.sourceId);
      if(proposal.type==='supplier-invoice-coding')Demo.patch(state=>{const invoice=state.supplierInvoices.find(row=>row.id===proposal.sourceId);if(invoice){invoice.coding=structuredClone(proposal.suggestion?.lines||proposal.review?.accountingLines||[]);invoice.status='coded'}});
    }catch(error){console.warn('Demo workflow execution stopped:',error.message)}
  },true);
})();
