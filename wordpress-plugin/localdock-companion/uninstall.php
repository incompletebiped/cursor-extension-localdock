<?php
/**
 * Fires only when the plugin is deleted from the Plugins screen (not on
 * mere deactivation). Deliberately self-contained — does not require
 * includes/class-changelog.php — so cleanup does not depend on the rest
 * of the plugin still being loadable at uninstall time.
 */

if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	exit;
}

global $wpdb;

$wpdb->query( "DROP TABLE IF EXISTS {$wpdb->prefix}localdock_changelog" );

delete_option( 'localdock_api_key' );

wp_clear_scheduled_hook( 'localdock_prune_changelog_event' );
