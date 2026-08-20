<?php
/**
 * Plugin Name:       LocalDock Companion
 * Description:       Read-only change tracking for LocalDock (cPanel WordPress dev workflow). Logs native WP change events to a local changelog table and exposes them via a read-only REST endpoint so LocalDock can detect drift since the last pull without a full file/DB diff.
 * Version:           0.2.0
 * Requires at least: 5.8
 * Requires PHP:      7.4
 * Author:            LocalDock
 * License:           GPL-2.0-or-later
 * Text Domain:       localdock-companion
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'LOCALDOCK_COMPANION_VERSION', '0.2.0' );
define( 'LOCALDOCK_COMPANION_DIR', plugin_dir_path( __FILE__ ) );

require_once LOCALDOCK_COMPANION_DIR . 'includes/class-changelog.php';
require_once LOCALDOCK_COMPANION_DIR . 'includes/class-rest-api.php';
require_once LOCALDOCK_COMPANION_DIR . 'includes/class-admin.php';

register_activation_hook( __FILE__, array( 'LocalDock_Changelog', 'on_activate' ) );
register_deactivation_hook( __FILE__, array( 'LocalDock_Changelog', 'on_deactivate' ) );

// Registered immediately (not deferred to plugins_loaded) so the
// activated_plugin listener is wired in time to catch this plugin's own
// activation — plugins_loaded has already fired by the time WordPress
// processes an "Activate" click and include_once's this file.
LocalDock_Changelog::init();
add_action( 'rest_api_init', array( 'LocalDock_REST_API', 'register_routes' ) );
LocalDock_Admin::init();
