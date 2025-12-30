document.addEventListener("DOMContentLoaded", function () {
  var options = {
    buttonTemplate:
      '<button class="littlefoot__button" id="<% reference %>" title="See footnote <% number %>">' +
      '<span class="littlefoot__button-number"><% number %></span>' +
      "</button>",
  };

  if (window.littlefoot && window.littlefoot.littlefoot) {
    window.littlefoot.littlefoot(options);
  } else if (window.littlefoot && window.littlefoot.default) {
    window.littlefoot.default(options);
  }
});
