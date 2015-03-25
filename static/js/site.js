/**
 * Main JS file for Casper behaviours
 */

/* globals jQuery, document */
(function ($, undefined) {
    "use strict";
    var $document = $(document);
    $document.ready(function () {
      $('pre code').each(function(i, block) {
        hljs.highlightBlock(block);
      });
    });
})(jQuery);
