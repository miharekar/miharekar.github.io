---
layout: post
category: posts
title: "(Ab)using Rails 7.1's #generates_token_for for List-Unsubscribe Headers"
excerpt: "How I migrated Business ECT from Amazon SES to Postmark while adding List-Unsubscribe headers by (ab)using Rails 7.1's #generates_token_for."
tags: [rails, email-marketing, list-unsubscribe, postmark, amazon-ses, token-generation, smtp, migration, ruby, marketing-automation]
comments: true
---

I don't often post development content on this blog post, because most of the interesting Ruby work I do happens on [Visualizer](https://visualizer.coffee), and I have a [separate blog there](https://visualizer.coffee/updates). Sometimes I write [guest posts](https://radanskoric.com/guest-articles/pagy-out-turbo-in), but this time no other place seems to fit. I recently needed to migrate [European Coffee Trip Business](https://business.europeancoffeetrip.com/) from the very bare-bones Amazon SES to [Postmark](https://postmarkapp.com/) and I made some interesting decisions to make it work, so I thought it would be valuable to share it, and here we are. 👋

The first thing that is different about Postmark is that they differentiate between different [_message streams_](https://postmarkapp.com/message-streams). Basically, they want you to separate your **transactional** emails from your **broadcast** emails. The idea is that transactional emails are things like password resets, order confirmations, etc. and they should be sent immediately and have a very high deliverability. On the other hand, broadcast emails are things like newsletters, marketing emails, etc. and they can be sent in batches and can have a lower deliverability.

Luckily, I already differentiate between these two types of emails in the app, since I quite early needed to have a way for people to unsubscribe from different types of emails. I'm quite proud of the way I've implemented this, so I'll give a quick overview of that first.

## A Quick Overview of the App

The app defines different types of user roles: `:admin`, `:editor`, `:cafe_manager`, and `:sponsor`. Each of them has their own mailer class: `AdminMailer`, `EditorMailer`, `CafeManagerMailer`, and `SponsorMailer` respectively. They all inherit from `ApplicationMailer` which in turn inherits from `ActionMailer::Base`. I also have a `User` model which has an JSONB `roles` array attribute. Pretty standard so far.

All possible email notifications are in a hash constant on the `User` like so:

```ruby
ALL_EMAIL_NOTIFICATIONS = {
  admin: [],
  editor: %i[new_cafe_change_request new_cafe_submitted],
  cafe_manager: %i[new_cafe_change_request change_request_approved change_request_rejected monthly_report],
  sponsor: []
}
```

And they have corresponding methods in their mailer classes. For example, `EditorMailer` has a `new_cafe_change_request` method:

```ruby
def new_cafe_change_request(change_request)
  @user = params[:user]
  @change_request = change_request
  mail to: @user.email, subject: "New change request for #{@change_request.cafe.name} by #{@change_request.user.display_name}"
end
```

That is called from a `ChangeRequest` model like so:

```ruby
def notify_editors
  User.with_role(:editor).each do |editor|
    EditorMailer.with(user: editor).new_cafe_change_request(self).deliver_later
  end
end
```

Finally, I have a JSONB array `unsubscribed_from` on `User` which contains all the notifications the user has unsubscribed from. For example, if a user with the `:editor` role has unsubscribed from `:new_cafe_change_request` and `:new_cafe_submitted` notifications, their `unsubscribed_from` array would look like this:

```ruby
["editor_new_cafe_change_request", "editor_new_cafe_submitted"]
```

Quite straight-forward so far, right?

Here comes the fun part! In `ApplicationMailer` I have a `before_action :check_notification`. And here's how that works:

```ruby
def check_notification
  return unless params.try(:[], :user).is_a?(User)
  return unless notification_exists?

  notification = "#{notification_prefix}_#{action_name}"
  self.response_body = :do_not_deliver unless params[:user].notify?(notification)
end

def notification_exists?
  User::ALL_EMAIL_NOTIFICATIONS.fetch(notification_prefix, []).include?(action_name.to_sym)
end

def notification_prefix
  @notification_prefix ||= self.class.name.sub(/Mailer$/, "").underscore.to_sym
end
```

So, when a mailer is about to send an email, it first checks if it's a notification and if the user has unsubscribed from that notification. If they have, it sets the response body to `:do_not_deliver` and the email is simply not sent.

## A Brief Aside

You might be wondering if `:do_not_deliver` is some special Rails magic symbol. It's not. You could return `:please_deliver` or `:foobar` and it would still **not** be delivered. The reason is that if the `response_body` is set to _anything_, the email will not be sent. So how does that work?

Callbacks for mailers are implemented using `AbstractController::Callbacks` that have a [`performed?` terminator lambda](https://github.com/rails/rails/blob/029d31ca31ab72df7bb79372f4ff057231fd0196/actionpack/lib/abstract_controller/callbacks.rb#L34):

```ruby
define_callbacks :process_action,
  terminator: ->(controller, result_lambda) { result_lambda.call; controller.performed? },
  skip_after_callbacks_if_terminated: true
```

And `AbstractController::Base` [defines `performed?` simply as `response_body`](https://github.com/rails/rails/blob/029d31ca31ab72df7bb79372f4ff057231fd0196/actionpack/lib/abstract_controller/base.rb#L193-L195):

```ruby
def performed?
  response_body
end
```

Then there's some complex metaprogramming in `Active Support::Callbacks` that I really don't want to go into, but from the _terminator_ naming, you can understand that as soon as it is _truthy_ the callback chain will terminate. So when we set `response_body` to anything, **no other callbacks or actions are executed**. Thus, the email is not sent.

## Postmark Message Streams

As I mentioned, emails that are not defined in the notifications constant will simply skip the check. And what are emails that are not defined as notifications? Transactional! So, I can simply use the existing `notification_exists?` to check if an email is transactional or broadcast. And that's exactly what I did by adding to `default`:

```ruby
- default from: email_address_with_name("team@europeancoffeetrip.com", "European Coffee Trip")
+ default from: email_address_with_name("team@europeancoffeetrip.com", "European Coffee Trip"),
+   message_stream: -> { notification_exists? ? "broadcast" : "outbound" }
```

That's it! Now all emails that are not defined as notifications will be sent as transactional emails, and all emails that are defined as notifications will be sent as broadcast emails. Postmark is happy, and I'm happy.

## Unsubscribe Headers

But[^1], that's not the end of the story. There's this thing called _List-Unsubscribe headers_ ([RFC 8058](https://datatracker.ietf.org/doc/html/rfc8058) and [RFC 2369](https://datatracker.ietf.org/doc/html/rfc2369)) that allow receiving email clients to add an unsubscribe option to the messages you've sent. Starting in **June 2024**, Gmail and Yahoo will [**require**](https://postmarkapp.com/blog/2024-gmail-yahoo-email-requirements) marketing messages to include these headers.

While Postmark has a built-in way to add these headers, it's not very flexible. It unsubscribes the receiver from **all** emails from the message stream. So I could either create a separate message stream for each notification, or I could add my own List-Unsubscribe headers. I have the logic already in place, so I decided to do the latter. How hard could it be?

Upon reading the RFCs, and Google's requirements it became clear that I needed to implement the _One-Click Unsubscribe_. This means that the user should be able to click a link in the email and be unsubscribed from that specific notification.

**I don't want random people to be able to unsubscribe other people**, so I would need some kind of tamper-proof token. This is where I remembered that [Rails 7.1 shipped with this new `#generates_token_for` method](https://blog.saeloun.com/2023/11/14/rails-7-1-introduces-active-record-generate-token-for/).

It's a very simple method that you can use to generate a token for a specific purpose like password reset or email confirmation. So you can generate a token for a record, and then later retrieve that record via the token. But you can't _store_ anything extra. And I would need to reference the notification name in the token. I could use a different _purpose_ for each notification, but that seemed like an overkill. I decided to read through the Rails codebase, and see what I could do.

## Extending Existing Functionality

I decided to borrow from existing code, and add a bit to it. I defined a single token purpose with `generates_token_for :unsubscribe`. Then I added this instance method:

```ruby
def unsubscribe_token_for(notification)
  token_definition = self.class.token_definitions[:unsubscribe]
  token_definition.message_verifier.generate({id:, notification:}, purpose: token_definition.full_purpose)
end
```

It creates a **signed tamper-proof token that never expires**. The token contains the User's `id` and the notification name. Finally, I added this class method on `User`:

```ruby
def self.unsubscribe_by_token!(token)
  token_definition = token_definitions[:unsubscribe]
  payload = token_definition.message_verifier.verified(token, purpose: token_definition.full_purpose)
  return unless payload && payload[:id].present? && payload[:notification].present?

  user = find_by(id: payload[:id])
  return unless user

  unsubscribed_from = (user.unsubscribed_from + [payload[:notification]]).uniq
  user.update!(unsubscribed_from:)
  payload[:notification]
end
```

The method verifies the token, finds the user, and adds the notification to the `unsubscribed_from` array.

Now, all I needed was a front-end part. And this boiled down to adding `post "emails/unsubscribe"` to my routes, and a trivial controller action:

```ruby
def unsubscribe
  notification = User.unsubscribe_by_token!(params[:token])
  flash[:notice] = "You have been unsubscribed from #{notification.humanize}. You can always resubscribe in your profile." if notification
  redirect_to root_path
end
```

Now I had all the parts in place and I can add the List-Unsubscribe headers to the emails. Since I only need these for notification emails, I can simply extend the previously explained `check_notification` method:

```ruby
def check_notification
  return unless params.try(:[], :user).is_a?(User)
  return unless notification_exists?

  if params[:user].notify?(notification_name)
    token = params[:user].unsubscribe_token_for(notification_name)
    headers["List-Unsubscribe"] = "<#{emails_unsubscribe_url(token:)}>, <mailto:team+unsubscribe@europeancoffeetrip.com?subject=Unsubscribe>"
    headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click"
  else
    self.response_body = :do_not_deliver
  end
end
```

And that's it! Now I have a very simple way to add List-Unsubscribe headers to my emails, and users can unsubscribe from specific notifications with a single click from their email clients. No new tables, no new columns, no new message streams, no new complicated logic. Just a few lines of code extending the existing Rails 7.1 functionality. ✨

And when I want to add a new notification, or convert an existing email to a notification, I simply add it to the `ALL_EMAIL_NOTIFICATIONS` constant, and I'm done. No need to worry about creating new message streams, or adding new tokens, or anything else. It's all taken care of _automagically_. 🪄

I hope you found this interesting, and maybe it even helps you with your own email setup. If you have any questions, feel free to ask in the comments below or reach out by email.

[^1]: and of course there's a "but", otherwise this post would be pretty lame, right?
